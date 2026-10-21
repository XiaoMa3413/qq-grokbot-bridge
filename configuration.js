'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

function loadConfig({ dir = __dirname, env = process.env } = {}) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  if (c.contextTextMaxChars === undefined) c.contextTextMaxChars = 12000;
  if (!Number.isSafeInteger(c.contextTextMaxChars) || c.contextTextMaxChars < 256 || c.contextTextMaxChars > 65536)
    throw Object.assign(new Error('contextTextMaxChars must be an integer from 256 to 65536'), { code: 'ECONTEXTBUDGET' });
  for (const key of ['historyLimitC2c', 'historyLimitGroup']) if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > 1000))
    throw Object.assign(new Error('history limits must be integers from 1 to 1000'), { code: 'ECONTEXTLIMIT' });
  c.forwardWebhookUrl = env.QQ_FORWARD_WEBHOOK_URL || c.forwardWebhookUrl;
  if (env.QQ_API_BASE) c.apiBase = env.QQ_API_BASE;
  if (env.QQ_TOKEN_URL) c.tokenUrl = env.QQ_TOKEN_URL;
  if (env.QQ_REPLY_PORT) c.replyPort = +env.QQ_REPLY_PORT;
  c.replyPublicUrl = env.QQ_REPLY_PUBLIC_URL || '';
  if (c.replyPublicUrl) {
    const u = new URL(c.replyPublicUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/reply')
      throw new Error('QQ_REPLY_PUBLIC_URL must be an HTTPS URL ending in /reply without credentials, query or fragment');
    c.replyPublicUrl = u.href;
  }
  return c;
}
function validateReplyToken(value) {
  if (typeof value !== 'string' || value.trim().length < 32) {
    const error = new Error('QQ_REPLY_TOKEN or reply_token must contain at least 32 characters');
    error.code = 'EWEAKTOKEN'; throw error;
  }
  return value.trim();
}
function loadReplyToken({ dir = __dirname, env = process.env, create = true } = {}) {
  if (env.QQ_REPLY_TOKEN !== undefined) return validateReplyToken(env.QQ_REPLY_TOKEN);
  const file = path.join(dir, 'reply_token');
  try { return validateReplyToken(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
  }
  try { fs.writeFileSync(file, crypto.randomBytes(24).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return validateReplyToken(fs.readFileSync(file, 'utf8'));
}
module.exports = { loadConfig, loadReplyToken, validateReplyToken };
