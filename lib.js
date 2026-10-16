'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), util = require('util');
const { Agent, fetch } = require('undici');
const { parseElements, refMsgIdx, parseRecentContext } = require('./events');
const DIR = __dirname;
// One shared agent for every outbound fetch, so sockets are reused and connect/header/body
// timeouts are enforced by the agent rather than by the caller.
const dispatcher = new Agent({
  connect: { timeout: 10000 },
  headersTimeout: 15000,
  bodyTimeout: 15000,
});
function loadConfig() {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  c.forwardWebhookUrl = process.env.QQ_FORWARD_WEBHOOK_URL || c.forwardWebhookUrl;
  if (process.env.QQ_API_BASE) c.apiBase = process.env.QQ_API_BASE;
  if (process.env.QQ_TOKEN_URL) c.tokenUrl = process.env.QQ_TOKEN_URL;
  if (process.env.QQ_REPLY_PORT) c.replyPort = +process.env.QQ_REPLY_PORT;
  return c;
}
// Network timeout for every outbound fetch (token, QQ API, forward webhook).
const HTTP_TIMEOUT_MS = Number(process.env.QQ_HTTP_TIMEOUT_MS) || 15000;
// fetch() that reports its abort as an ETIMEDOUT error so callers/retries treat it as a timeout.
async function fetchTimeout(url, init) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), dispatcher }); }
  catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      const t = new Error(`timeout after ${HTTP_TIMEOUT_MS}ms: ${url}`); t.code = 'ETIMEDOUT'; throw t;
    }
    throw e;
  }
}
// Synchronous stdout write, so log lines never interleave or get dropped on abrupt exit.
function log(...a) { fs.writeSync(1, new Date().toISOString() + ' ' + util.format(...a) + '\n'); }
// Convert a QQ dispatch event to the forward payload
function toPayload(t, d) {
  const base = {
    author: d.author ? { ...d.author } : {},
    nickname: (d.author && d.author.username) || null,
    group_card: (d.author && d.author.card) || (d.member && d.member.card) || (d.member && d.member.nick) || null,
    content: (d.content || '').trim(), msg_id: d.id, timestamp: d.timestamp,
    attachments: d.attachments || [],
    message_type: d.message_type ?? null, ref_msg_idx: refMsgIdx(d), quoted: parseElements(d).quoted,
    recent_context: (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') ? parseRecentContext(d) : [] };
  if (t === 'C2C_MESSAGE_CREATE') return { type: 'c2c', openid: d.author && d.author.user_openid, ...base };
  if (t === 'GROUP_AT_MESSAGE_CREATE') return { type: 'group', group_openid: d.group_openid, at: true, ...base };
  if (t === 'GROUP_MESSAGE_CREATE') return { type: 'group', group_openid: d.group_openid, at: false, ...base };
  return null;
}
function loadReplyToken() {
  const f = path.join(DIR, 'reply_token');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
class TokenManager {
  constructor(cfg, appId, secret) { this.cfg = cfg; this.appId = appId; this.secret = secret; this.token = null; this.exp = 0; this.p = null; }
  async get() {
    if (this.token && Date.now() < this.exp - 60000) return this.token;
    if (!this.p) this.p = this._fetch().finally(() => { this.p = null; });
    return this.p;
  }
  async _fetch() {
    const r = await fetchTimeout(this.cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }) });
    const j = await r.json();
    if (!j.access_token) throw new Error('getAppAccessToken failed: ' + JSON.stringify({ code: j.code, message: j.message }));
    this.token = j.access_token; this.exp = Date.now() + Number(j.expires_in || 7200) * 1000;
    log('access token refreshed, expires_in', j.expires_in);
    return this.token;
  }
}
class QQApi {
  constructor(cfg, tm) { this.cfg = cfg; this.tm = tm; this.seq = new Map(); }
  async req(method, p, body) {
    const r = await fetchTimeout(this.cfg.apiBase + p, { method, headers: {
      Authorization: 'QQBot ' + await this.tm.get(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) { const e = new Error(`QQ API ${r.status}`); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  nextSeq(msgId) { const n = (this.seq.get(msgId) || 0) + 1; this.seq.set(msgId, n);
    if (this.seq.size > 5000) this.seq.delete(this.seq.keys().next().value); return n; }
  send(type, target, content, msgId) {
    const p = type === 'c2c' ? `/v2/users/${encodeURIComponent(target)}/messages`
                             : `/v2/groups/${encodeURIComponent(target)}/messages`;
    const body = { content, msg_type: 0 };
    if (msgId) { body.msg_id = msgId; body.msg_seq = this.nextSeq(msgId); }
    return this.req('POST', p, body);
  }
  // Upload a local image as rich media. Returns the parsed response (which carries file_info for sendMedia).
  uploadImage(type, target, buf, fileName) {
    const p = type === 'c2c' ? `/v2/users/${encodeURIComponent(target)}/files`
                             : `/v2/groups/${encodeURIComponent(target)}/files`;
    const body = { file_type: 1, file_data: buf.toString('base64'), file_name: fileName, srv_send_msg: false };
    return this.req('POST', p, body);
  }
  // Send an already-uploaded rich-media image (msg_type 7). fileInfo is the file_info from uploadImage.
  sendMedia(type, target, fileInfo, msgId) {
    const p = type === 'c2c' ? `/v2/users/${encodeURIComponent(target)}/messages`
                             : `/v2/groups/${encodeURIComponent(target)}/messages`;
    const body = { msg_type: 7, media: { file_info: fileInfo } };
    if (msgId) { body.msg_id = msgId; body.msg_seq = this.nextSeq(msgId); }
    return this.req('POST', p, body);
  }
}
module.exports = { loadConfig, log, toPayload, loadReplyToken, TokenManager, QQApi, DIR, HTTP_TIMEOUT_MS, dispatcher, fetch };
