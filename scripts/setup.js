'use strict';
const path = require('node:path');
const { initialize } = require('./config-tools');
const args = process.argv.slice(2), json = args.includes('--json');
try {
  let from;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--from' && args[i + 1] && !args[i + 1].startsWith('--')) { from = args[++i]; continue; }
    if (args[i] === '--help') {
      console.log('Usage: npm run setup -- [--from <env-file>] [--json]\nCreates missing .env and reply_token; preserves existing configuration.');
      process.exit(0);
    }
    throw Object.assign(new Error('invalid arguments'), { code: 'EUSAGE' });
  }
  const result = initialize({ dir: path.resolve(__dirname, '..'), from });
  if (json) console.log(JSON.stringify(result));
  else {
    console.log(result.configuration === 'created' ? '已创建 .env。' : '已保留现有 .env。');
    if (result.source === 'skipped_existing') console.log('现有配置未覆盖，未重新导入源文件。');
    console.log('回复密钥已就绪（不显示密钥）。填写配置后运行 npm run doctor。');
  }
} catch (error) {
  const message = error.code === 'EUSAGE' ? '参数无效；使用 --help 查看用法。'
    : error.code === 'EWEAKTOKEN' ? '回复密钥需至少 32 字符；检查 QQ_REPLY_TOKEN 或 reply_token。'
    : error.code === 'ENOENT' ? '找不到 .env.example 或导入凭据文件；请检查文件位置。'
    : error.code === 'EENVVALUE' ? '导入值需为可写入 env 文件的单行字符串。'
    : '初始化失败；请检查配置文件和读写权限。';
  const result = { ok: false, error: message };
  if (json) console.log(JSON.stringify(result)); else console.error(result.error);
  process.exitCode = 1;
}
