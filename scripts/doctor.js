'use strict';
const fs = require('node:fs'), path = require('node:path');
const { loadConfig, loadReplyToken } = require('../configuration');
const { effectiveEnvironment } = require('./config-tools');
const { readJobs } = require('../job_state');
const { KnowledgeStore } = require('../knowledge');
const { checkOutboundStorage } = require('../outbound_store');
const loopback = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
function validHttp(value) {
  try {
    const u = new URL(value);
    return !u.username && !u.password && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && loopback(u.hostname)));
  } catch { return false; }
}
function placeholder(value) { return typeof value === 'string' && (/<[^>]+>/.test(value) || /^(your[_-]|replace[_-]|change[_-]?me)/i.test(value)); }
async function diagnose({ dir = path.resolve(__dirname, '..'), env = process.env, live = false, requireRemote = false, nodeVersion = process.versions.node } = {}) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  const [major, minor] = nodeVersion.split('.').map(Number);
  add('node', major > 22 || (major === 22 && minor >= 9) ? 'pass' : 'fail', '需要 Node.js 22.9 或以上。');
  for (const name of ['ws', 'undici']) {
    try { require.resolve(name, { paths: [dir] }); add('dependency.' + name, 'pass', name + ' 已安装。'); }
    catch { add('dependency.' + name, 'fail', name + ' 未安装；运行 npm ci。'); }
  }
  let effective;
  try {
    effective = effectiveEnvironment(dir, env);
    add('env_file', effective.file ? 'pass' : 'warn', effective.file ? '.env 可读取。' : '.env 不存在；使用环境变量配置或运行 npm run setup。');
    add('environment_overrides', effective.overridden.length ? 'warn' : 'pass', effective.overridden.length
      ? '环境变量覆盖 .env：' + effective.overridden.join(', ') + '。服务进程须使用相同配置。' : '未发现环境变量与 .env 的值冲突。');
  } catch { add('env_file', 'fail', '.env 无法读取或格式不适用；请检查文件和权限。'); }
  if (!effective) return finish();
  const values = effective.env;
  for (const key of ['QQ_APP_ID', 'QQ_APP_SECRET']) {
    const good = typeof values[key] === 'string' && values[key].trim() && !placeholder(values[key]);
    add(key, good ? 'pass' : 'fail', good ? key + ' 已配置。' : key + ' 缺失或仍为占位值。');
  }
  let cfg;
  try { cfg = loadConfig({ dir, env: values }); add('config', 'pass', 'config.json 与公网回复地址可解析。'); }
  catch (error) { add('config', 'fail', error.code === 'ECONTEXTBUDGET'
    ? 'config.json 的 contextTextMaxChars 需为 256–65536 的整数。'
    : error.code === 'ECONTEXTLIMIT' ? 'config.json 的 historyLimitC2c / historyLimitGroup 需为 1–1000 的整数。'
    : '检查 config.json，以及 QQ_REPLY_PUBLIC_URL 是否为无查询参数、无片段、无凭据的 HTTPS /reply 地址。'); }
  const mode = cfg ? cfg.replyPublicUrl ? 'remote' : 'local' : null;
  if (cfg) {
    add('webhook', validHttp(cfg.forwardWebhookUrl) && !placeholder(cfg.forwardWebhookUrl) ? 'pass' : 'fail',
      'QQ_FORWARD_WEBHOOK_URL 需为有效 HTTPS 地址；本机开发允许回环 HTTP。');
    add('reply_mode', mode === 'remote' ? 'pass' : requireRemote ? 'fail' : 'warn', mode === 'remote'
      ? '已启用持久化远程模式。' : '当前为本机模式；远程部署需设置 QQ_REPLY_PUBLIC_URL。');
    add('reply_port', Number.isInteger(cfg.replyPort) && cfg.replyPort > 0 && cfg.replyPort <= 65535 ? 'pass' : 'fail',
      'QQ_REPLY_PORT 需为 1–65535 的整数。');
    add('reply_host', typeof cfg.replyHost !== 'string' || !cfg.replyHost || /[\s/?#@\[\]]/.test(cfg.replyHost) ? 'fail' : loopback(cfg.replyHost) ? 'pass' : 'warn',
      'replyHost 建议使用回环地址；其他监听地址需限制访问范围。');
    for (const [key, value] of [['QQ_API_BASE', cfg.apiBase], ['QQ_TOKEN_URL', cfg.tokenUrl]])
      add(key, validHttp(value) ? 'pass' : 'fail', key + ' 需为 HTTPS 地址；本机模拟服务允许回环 HTTP。');
  }
  for (const key of ['QQ_HTTP_TIMEOUT_MS', 'QQ_READY_TIMEOUT_MS', 'QQ_LIVENESS_MAX_AGE_MS']) if (values[key] !== undefined) {
    const n = Number(values[key]);
    add(key, Number.isSafeInteger(n) && n > 0 ? 'pass' : 'fail', key + ' 需为正整数毫秒。');
  }
  try { loadReplyToken({ dir, env: values, create: false }); add('reply_token', 'pass', '回复密钥已配置。'); }
  catch (error) { add('reply_token', 'fail', error.code === 'ENOENT' ? '回复密钥缺失；运行 npm run setup。' : '回复密钥无法读取或不足 32 字符；检查 QQ_REPLY_TOKEN / reply_token。'); }
  for (const [key, fallback] of [['QQ_JOBS_DIR', 'data/jobs'], ['QQ_HISTORY_DIR', 'data/history'], ['QQ_MEDIA_DIR', 'data/media'], ['QQ_MEMORY_DIR', 'memory'], ['QQ_KNOWLEDGE_DIR', 'data/knowledge']]) {
    let target = path.resolve(dir, values[key] || fallback);
    try {
      for (;;) {
        try { fs.lstatSync(target); break; }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
        const parent = path.dirname(target);
        if (parent === target) throw new Error('no existing parent');
        target = parent;
      }
      if (!fs.statSync(target).isDirectory()) throw new Error('not a directory');
      fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
      add(key, 'pass', key + ' 的目录或创建所需的父目录可访问。');
    } catch { add(key, 'fail', key + ' 不是可访问的数据目录；检查路径与读写权限。'); }
  }
  try {
    const count = new KnowledgeStore({ dir: path.resolve(dir, values.QQ_KNOWLEDGE_DIR || 'data/knowledge') }).check();
    add('knowledge_state', 'pass', `角色与导入事实校验通过（${count} 个会话）；未修改文件。`);
  } catch { add('knowledge_state', 'fail', '无法读取有效的角色与导入事实；保留原文件，核对备份和存储权限。'); }
  if (mode === 'remote') {
    try {
      checkOutboundStorage(path.resolve(dir, values.QQ_JOBS_DIR || 'data/jobs'));
      add('outbound_storage', 'pass', '文件与语音上传目录可用或尚未创建；未修改文件。');
    } catch { add('outbound_storage', 'fail', '文件与语音上传目录无效；检查权限，禁止将其替换为符号链接。'); }
    try {
      const jobs = readJobs(path.resolve(dir, values.QQ_JOBS_DIR || 'data/jobs'));
      add('job_state', 'pass', `持久化任务校验通过（${jobs.length} 条）；未修改任务文件。`);
    } catch (error) {
      add('job_state', 'fail', error.code === 'EJOBSTATE'
        ? `任务文件 ${error.file} 的 ${error.field} 无效；保留原文件，核对备份后修复。`
        : '无法读取任务队列；检查目录与读取权限。');
    }
  }
  if (process.platform !== 'win32') for (const name of ['.env', 'reply_token']) {
    try {
      if (fs.statSync(path.join(dir, name)).mode & 0o077)
        add('permissions.' + name, 'warn', name + ' 可被其他用户访问；建议 chmod 600。');
    } catch { /* Missing or unreadable configuration is reported above. */ }
  }
  if (live && cfg && Number.isInteger(cfg.replyPort) && cfg.replyPort > 0 && cfg.replyPort <= 65535) {
    try {
      // The optional live check only contacts loopback, without credentials or redirects.
      const host = loopback(cfg.replyHost) ? cfg.replyHost === '::1' ? '[::1]' : cfg.replyHost : '127.0.0.1';
      const r = await fetch(`http://${host}:${cfg.replyPort}/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      let size = 0; const chunks = [];
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > 16384) throw new Error('health response too large');
        chunks.push(Buffer.from(chunk));
      }
      const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (health?.mode === 'probe') add('live', 'fail', '当前运行的是隧道探测服务，尚未连接 QQ。');
      else add('live', r.ok && health?.ok === true && health.ws_state === 'OPEN' && typeof health.version === 'string' ? 'pass' : 'fail',
        r.ok && health?.ok === true && health.ws_state === 'OPEN' && typeof health.version === 'string' ? '运行中的桥接健康。' : '桥接尚未就绪或报告不健康。');
    } catch { add('live', 'fail', '无法读取本机桥接健康状态；检查服务、端口及是否完成启动。'); }
  }
  return finish(mode);
  function finish(mode = null) { return { ok: !checks.some(c => c.status === 'fail'), mode, checks }; }
}
async function main() {
  const args = process.argv.slice(2), json = args.includes('--json');
  if (args.includes('--help')) {
    console.log('Usage: npm run doctor -- [--json] [--remote] [--live]\nChecks local configuration without changing files. --remote requires remote mode; --live also checks the loopback /health endpoint.'); return;
  }
  if (args.some(arg => !['--json', '--live', '--remote'].includes(arg))) {
    const result = { ok: false, error: '未知参数；使用 --help 查看用法。' };
    console.log(json ? JSON.stringify(result) : result.error); process.exitCode = 1; return;
  }
  const report = await diagnose({ live: args.includes('--live'), requireRemote: args.includes('--remote') });
  if (json) console.log(JSON.stringify(report));
  else {
    for (const check of report.checks) console.log(`[${check.status.toUpperCase()}] ${check.message}`);
    console.log(report.ok ? '本地配置检查通过。' : '检查未通过，请修复 FAIL 项。');
  }
  if (!report.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(() => {
  console.log(process.argv.includes('--json') ? JSON.stringify({ ok: false, error: '诊断失败；请检查文件与执行环境。' }) : '诊断失败；请检查文件与执行环境。');
  process.exitCode = 1;
});
module.exports = { diagnose };
