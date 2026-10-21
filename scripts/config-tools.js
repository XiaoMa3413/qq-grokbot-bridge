'use strict';
const fs = require('node:fs'), path = require('node:path');
const { parseEnv } = require('node:util');
const { loadReplyToken, validateReplyToken } = require('../configuration');
const IMPORT_KEYS = ['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_FORWARD_WEBHOOK_URL', 'QQ_FORWARD_WEBHOOK_SECRET',
  'QQ_FORWARD_WEBHOOK_HEADER', 'QQ_REPLY_PORT', 'QQ_REPLY_PUBLIC_URL', 'QQ_REPLY_TOKEN'];
function readEnv(file, optional = false) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 65536) throw new Error('invalid configuration file');
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (text.includes('\0')) throw new Error('invalid configuration file');
    return { text, values: parseEnv(text) };
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
function quoted(value) {
  if (/[\r\n\0]/.test(value)) throw Object.assign(new Error('configuration values must be single-line strings'), { code: 'EENVVALUE' });
  for (const quote of ['"', "'", '`']) if (!value.includes(quote)) {
    const literal = quote + value + quote;
    // Double quotes expand literal backslash-n; select a form the Node parser reads losslessly.
    if (parseEnv('VALUE=' + literal + '\n').VALUE === value) return literal;
  }
  throw Object.assign(new Error('configuration value cannot be represented in an env file'), { code: 'EENVVALUE' });
}
function initialize({ dir, env = process.env, from } = {}) {
  const file = path.join(dir, '.env');
  let current = readEnv(file, true), created = false;
  if (!current) {
    let text = readEnv(path.join(dir, '.env.example')).text;
    if (from) {
      const source = readEnv(path.resolve(from)).values;
      const lines = [];
      for (const key of IMPORT_KEYS) if (source[key]?.trim()) {
        if (key === 'QQ_REPLY_TOKEN') validateReplyToken(source[key]);
        lines.push(key + '=' + quoted(source[key]));
      }
      text = text.trimEnd() + '\n\n' + lines.join('\n') + '\n';
    }
    const planned = { ...parseEnv(text), ...env };
    // Validate an existing token before creating any configuration; never silently rotate one.
    try { loadReplyToken({ dir, env: planned, create: false }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    current = readEnv(file);
  }
  const effective = { ...current.values, ...env };
  const tokenFileExists = fs.existsSync(path.join(dir, 'reply_token'));
  loadReplyToken({ dir, env: effective });
  const replyToken = effective.QQ_REPLY_TOKEN !== undefined
    ? (env.QQ_REPLY_TOKEN !== undefined ? 'environment' : 'configured') : tokenFileExists ? 'preserved' : 'created';
  return { ok: true, configuration: created ? 'created' : 'preserved', reply_token: replyToken,
    source: from ? created ? 'imported' : 'skipped_existing' : created ? 'template' : 'existing' };
}
function effectiveEnvironment(dir, env = process.env) {
  const file = readEnv(path.join(dir, '.env'), true);
  const values = file?.values || {};
  const keys = [...IMPORT_KEYS, 'QQ_API_BASE', 'QQ_TOKEN_URL', 'QQ_JOBS_DIR', 'QQ_HISTORY_DIR', 'QQ_MEDIA_DIR', 'QQ_MEMORY_DIR',
    'QQ_HTTP_TIMEOUT_MS', 'QQ_READY_TIMEOUT_MS', 'QQ_LIVENESS_MAX_AGE_MS', 'QQ_DEBUG_RAW_EVENTS'];
  const overridden = keys.filter(key => values[key] !== undefined && env[key] !== undefined && env[key] !== values[key]);
  return { env: { ...values, ...env }, file, overridden };
}
module.exports = { initialize, effectiveEnvironment, readEnv };
