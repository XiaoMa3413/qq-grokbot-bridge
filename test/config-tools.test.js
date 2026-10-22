'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
const { initialize } = require('../scripts/config-tools');
const { diagnose } = require('../scripts/doctor');
const TOKEN = 'setup-test-token-0123456789abcdef0123456789';
function fixture(t, { dependencies = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-test-'));
  for (const file of ['.env.example', 'config.json', 'configuration.js', 'policy.js', 'job_state.js', 'scripts/setup.js', 'scripts/doctor.js', 'scripts/config-tools.js']) {
    const target = path.join(dir, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', file), target);
  }
  if (dependencies) fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('qq-config-test-')) throw new Error('invalid test directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function config(dir, extra = '') {
  fs.writeFileSync(path.join(dir, '.env'), `QQ_APP_ID=TEST_APP\nQQ_APP_SECRET=test-only-app-secret\nQQ_FORWARD_WEBHOOK_URL=https://webhook.example/task?key=test-only-webhook-secret\nQQ_REPLY_PUBLIC_URL=https://bridge.example/reply\nQQ_REPLY_TOKEN=${TOKEN}\n` + extra, { mode: 0o600 });
}
function check(report, id) { return report.checks.find(c => c.id === id); }
async function cli(dir, name, args = []) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('QQ_')));
  const child = spawn(process.execPath, [path.join(dir, 'scripts', name + '.js'), ...args], { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr };
}

test('setup creates missing files once and preserves configuration and token on repeat', t => {
  const dir = fixture(t);
  assert.equal(initialize({ dir, env: {} }).configuration, 'created');
  const token = fs.readFileSync(path.join(dir, 'reply_token'), 'utf8');
  assert.equal(token.trim().length, 48);
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.deepEqual(initialize({ dir, env: {} }), { ok: true, configuration: 'preserved', reply_token: 'preserved', source: 'existing' });
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(dir, 'reply_token'), 'utf8'), token);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'reply_token')).mode & 0o777, 0o600);
  }
});

test('setup imports only supported data, preserves quotes and never overwrites existing configuration', t => {
  const dir = fixture(t), from = path.join(dir, 'source.env');
  const secret = 'value with # $ \\ " characters';
  fs.writeFileSync(from, `QQ_APP_ID=TEST\nQQ_APP_SECRET='${secret}'\nQQ_REPLY_TOKEN=${TOKEN}\nNODE_OPTIONS=--require=untrusted.cjs\nQQ_JOBS_DIR=/untrusted/directory\n`);
  const first = initialize({ dir, env: {}, from });
  assert.equal(first.source, 'imported'); assert.equal(first.reply_token, 'configured');
  const raw = fs.readFileSync(path.join(dir, '.env'), 'utf8'), parsed = parseEnv(raw);
  assert.equal(parsed.QQ_APP_SECRET, secret); assert.equal(parsed.QQ_REPLY_TOKEN, TOKEN);
  assert.equal(parsed.NODE_OPTIONS, undefined); assert.equal(parsed.QQ_JOBS_DIR, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'reply_token')), false);
  fs.writeFileSync(from, 'QQ_APP_ID=DIFFERENT\n');
  assert.equal(initialize({ dir, env: {}, from }).source, 'skipped_existing');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), raw);
});

test('setup refuses an invalid existing token without rotating it or writing a new env file', t => {
  const dir = fixture(t), file = path.join(dir, 'reply_token');
  fs.writeFileSync(file, 'short');
  assert.throws(() => initialize({ dir, env: {} }), /32 characters/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'short'); assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});

test('imported env values preserve literal backslash-n and mixed quotes', t => {
  for (const value of ['literal' + String.fromCharCode(92) + 'nvalue', 'it\'s a "quoted" value']) {
    const dir = fixture(t), from = path.join(dir, 'source.env');
    fs.writeFileSync(from, 'QQ_APP_SECRET=`' + value + '`\n');
    initialize({ dir, env: {}, from });
    assert.equal(parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8')).QQ_APP_SECRET, value);
  }
});

test('doctor on a fresh checkout is read-only and reports missing credentials and token', async t => {
  const dir = fixture(t), before = fs.readdirSync(dir).sort();
  const result = await diagnose({ dir, env: {} });
  assert.equal(result.ok, false); assert.equal(check(result, 'QQ_APP_ID').status, 'fail');
  assert.equal(check(result, 'reply_token').status, 'fail');
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(fs.existsSync(path.join(dir, 'data')), false);
});

test('doctor validates effective configuration without leaking secrets, and warns about environment overrides', async t => {
  const dir = fixture(t); config(dir);
  const healthy = await diagnose({ dir, env: {} });
  assert.equal(healthy.ok, true); assert.equal(healthy.mode, 'remote');
  const value = 'environment-override-secret-012345';
  const override = await diagnose({ dir, env: { QQ_APP_SECRET: value } });
  assert.equal(check(override, 'environment_overrides').status, 'warn');
  assert.match(check(override, 'environment_overrides').message, /QQ_APP_SECRET/);
  for (const secret of [TOKEN, value, 'test-only-app-secret', 'test-only-webhook-secret']) assert.ok(!JSON.stringify(override).includes(secret));
  assert.equal(check(await diagnose({ dir, env: { QQ_REPLY_PORT: 'not-a-port' } }), 'reply_port').status, 'fail');
  assert.equal(check(await diagnose({ dir, env: { QQ_REPLY_PUBLIC_URL: 'http://bridge.example/reply' } }), 'config').status, 'fail');
  assert.equal(check(await diagnose({ dir, env: { QQ_REPLY_TOKEN: '' } }), 'reply_token').status, 'fail');
  assert.equal(check(await diagnose({ dir, env: { QQ_APP_ID: '<AppID>' } }), 'QQ_APP_ID').status, 'fail');
  assert.equal(check(await diagnose({ dir, env: { QQ_HTTP_TIMEOUT_MS: 'NaN' } }), 'QQ_HTTP_TIMEOUT_MS').status, 'fail');
  assert.equal(check(await diagnose({ dir, env: {}, nodeVersion: '22.8.0' }), 'node').status, 'fail');
  assert.equal(check(await diagnose({ dir, env: { QQ_REPLY_PUBLIC_URL: '' } }), 'reply_mode').status, 'warn');
  assert.equal(check(await diagnose({ dir, env: { QQ_REPLY_PUBLIC_URL: '' }, requireRemote: true }), 'reply_mode').status, 'fail');
  assert.equal(fs.existsSync(path.join(dir, 'reply_token')), false);
  const configFile = path.join(dir, 'config.json'), current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...current, contextTextMaxChars: -1 }));
  const invalidBudget = await diagnose({ dir, env: {} });
  assert.equal(check(invalidBudget, 'config').status, 'fail'); assert.match(check(invalidBudget, 'config').message, /contextTextMaxChars/);
});

test('doctor identifies missing dependencies and invalid data paths without making changes', async t => {
  const dir = fixture(t, { dependencies: false }); config(dir);
  fs.writeFileSync(path.join(dir, 'blocked'), 'file');
  const result = await diagnose({ dir, env: { QQ_JOBS_DIR: 'blocked/child' } });
  assert.equal(check(result, 'dependency.ws').status, 'fail');
  assert.equal(check(result, 'QQ_JOBS_DIR').status, 'fail');
});

test('CLI JSON has meaningful exit codes, works outside the project cwd and never prints bad input values', async t => {
  const dir = fixture(t);
  const initial = await cli(dir, 'setup', ['--json']);
  assert.equal(initial.code, 0); assert.equal(JSON.parse(initial.stdout).configuration, 'created');
  const invalid = await cli(dir, 'doctor', ['--json']);
  assert.equal(invalid.code, 1); assert.equal(JSON.parse(invalid.stdout).ok, false);
  config(dir);
  const good = await cli(dir, 'doctor', ['--json']);
  assert.equal(good.code, 0); assert.equal(JSON.parse(good.stdout).ok, true);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"secret":"never-print-this-invalid-json"');
  const bad = await cli(dir, 'doctor', ['--json']);
  assert.equal(bad.code, 1); assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.ok(!bad.stdout.includes('never-print-this')); assert.equal(bad.stderr, '');
});

test('live doctor distinguishes bridge health from a probe, rejects redirects and does not send credentials', async t => {
  const dir = fixture(t); config(dir);
  let mode = 'healthy', calls = 0;
  const server = http.createServer((req, res) => {
    calls++; assert.equal(req.headers['x-reply-token'], undefined); assert.equal(req.headers.authorization, undefined);
    assert.equal(req.url, '/health');
    if (mode === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); return res.end(); }
    if (mode === 'probe') return res.end('{"ok":true,"mode":"probe","qq_connected":false}');
    if (mode === 'unhealthy') { res.writeHead(503); return res.end('{"ok":false}'); }
    res.end('{"ok":true,"ws_state":"OPEN","version":"1.3.0"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { QQ_REPLY_PORT: String(server.address().port) };
  assert.equal((await diagnose({ dir, env })).ok, true); assert.equal(calls, 0);
  assert.equal(check(await diagnose({ dir, env, live: true }), 'live').status, 'pass');
  for (mode of ['probe', 'unhealthy', 'redirect']) assert.equal(check(await diagnose({ dir, env, live: true }), 'live').status, 'fail');
  assert.equal(calls, 4);
});
