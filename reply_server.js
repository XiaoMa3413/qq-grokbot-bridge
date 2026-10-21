'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { log } = require('./lib');
const { append } = require('./history');
const { decodeImages, replyFingerprint } = require('./remote');
const { repliesOf } = require('./jobs');
const MAX_LEN = 1500;                        // QQ message content limit we split at
const TRUNC_NOTE = '\n…（内容过长，已截断）';
const ACTIVE_MAX = 5;                        // active (no msg_id): at most 5 messages
const PASSIVE_CAP = { c2c: 4, group: 5 };    // passive replies per msg_id (QQ limits)
// Split text into parts of at most `max` chars, preferring paragraph (\n\n), then line (\n) boundaries, then a hard cut. Each part keeps its trailing separator, so parts.join('') restores the original.
function splitContent(text, max) {
  const out = []; let rest = String(text);
  while (rest.length > max) {
    let cut;
    const para = rest.lastIndexOf('\n\n', max);
    if (para >= 0 && para + 2 <= max) cut = para + 2;
    else {
      const line = rest.lastIndexOf('\n', max);
      if (line >= 0 && line + 1 <= max) cut = line + 1;
      else cut = max;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}
// parts = the messages to send now; total = parts the full content would need; truncated = the last part was cut short.
function planParts(content, type, msgId, sentCount) {
  const cap = msgId ? (PASSIVE_CAP[type] || ACTIVE_MAX) : ACTIVE_MAX;
  const allowed = Math.max(0, cap - sentCount);
  const all = splitContent(content, MAX_LEN), total = all.length;
  let parts = all, truncated = false;
  if (all.length > allowed) {
    truncated = true;
    parts = all.slice(0, allowed);
    if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].slice(0, MAX_LEN - TRUNC_NOTE.length) + TRUNC_NOTE;
  }
  return { parts, total, truncated };
}
const IMAGE_MAX = 5 * 1024 * 1024;          // QQ file_data (base64 direct upload) limit: 5 MB
// Validate local image paths; returns { files:[{path,name,buf}] } or { error }.
function loadImages(j) {
  let list = [];
  if (j.image !== undefined) { if (typeof j.image !== 'string' || !j.image) return { error: 'image must be a non-empty string path' }; list.push(j.image); }
  if (j.images !== undefined) { if (!Array.isArray(j.images) || j.images.some(x => typeof x !== 'string' || !x)) return { error: 'images must be an array of path strings' }; list = list.concat(j.images); }
  const files = [];
  for (const f of list) {
    if (!path.isAbsolute(f)) return { error: 'image path must be absolute: ' + f };
    if (!/\.(png|jpe?g)$/i.test(f)) return { error: 'only .png/.jpg/.jpeg supported: ' + f };
    let st; try { st = fs.statSync(f); } catch { return { error: 'image not found: ' + f }; }
    if (!st.isFile()) return { error: 'not a regular file: ' + f };
    if (st.size > IMAGE_MAX) return { error: `image too large (${st.size} > ${IMAGE_MAX} bytes): ` + f };
    const buf = fs.readFileSync(f);
    const png = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (!png && !jpg) return { error: 'file content is not PNG/JPEG: ' + f };
    files.push({ path: f, name: path.basename(f), buf });
  }
  return { files };
}
function createReplyServer(api, token, getHealth, { remote = false, store = null, access = null } = {}) {
  return http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    const send = (c, o) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(c, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o));
    };
    if (req.method === 'GET' && req.url === '/health') {
      const h = getHealth ? getHealth() : { ok: true };
      return send(h.ok ? 200 : 503, h);
    }
    if (req.method === 'POST' && req.url === '/reply') res.on('finish', () => log('reply HTTP', res.statusCode));
    if (req.headers['x-reply-token'] !== token) return send(401, { ok: false, error: 'bad token' });
    if (access && access.handle(req, res, send)) return;
    if (req.method !== 'POST' || req.url !== '/reply') return send(404, { ok: false, error: 'not found' });
    let chunks = [], size = 0, tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > (store ? 8 * 1024 * 1024 : 1e6)) { tooLarge = true; chunks = []; send(413, { ok: false, error: 'body too large' }); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (tooLarge) return;
      let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { ok: false, error: 'invalid json' }); }
      if (!j || typeof j !== 'object' || Array.isArray(j)) return send(400, { ok: false, error: 'need a JSON object' });
      const target = j.type === 'c2c' ? j.openid : j.type === 'group' ? j.group_openid : null;
      const hasText = typeof j.content === 'string' && j.content.length > 0;
      const hasLocalImg = j.image !== undefined || j.images !== undefined;
      const hasImg = hasLocalImg || j.images_base64 !== undefined;
      if (remote && hasLocalImg) return send(400, { ok: false, error: 'server file paths are not accepted; use images_base64' });
      if (!remote && j.images_base64 !== undefined) return send(400, { ok: false, error: 'images_base64 requires remote mode' });
      if (remote && (typeof j.msg_id !== 'string' || !j.msg_id.trim()))
        return send(400, { ok: false, error: 'remote replies require the original msg_id' });
      if (typeof target !== 'string') return send(400, { ok: false, error: 'target must be a string' });
      if (!target || (!hasText && !hasImg) || (j.content !== undefined && typeof j.content !== 'string'))
        return send(400, { ok: false, error: 'need type(c2c|group), openid|group_openid, content and/or image(s)' });
      const imgs = remote ? decodeImages(j) : loadImages(j);
      if (imgs.error) return send(400, { ok: false, error: imgs.error });
      const job = store ? store.findReply(j) : null;
      if (store && !job) return send(404, { ok: false, error: 'unknown message route or job_id' });
      const seq = j.reply_seq === undefined ? 1 : j.reply_seq, final = j.final === undefined ? true : j.final;
      if ((j.reply_seq !== undefined || j.final !== undefined) && !store)
        return send(400, { ok: false, error: 'segmented replies require durable remote mode' });
      if (!Number.isInteger(seq) || seq < 1 || seq > 5 || typeof final !== 'boolean' || (!final && j.reply_seq === undefined))
        return send(400, { ok: false, error: 'reply_seq must be an integer from 1 to 5; final must be boolean; progress requires reply_seq' });
      if (!final && (!hasText || j.content.length > MAX_LEN || hasImg))
        return send(400, { ok: false, error: 'progress must be a single text message of at most 1500 characters, without images' });
      const cap = j.msg_id ? (PASSIVE_CAP[j.type] || ACTIVE_MAX) : ACTIVE_MAX;
      const used = Math.max(j.msg_id ? (api.seq.get(j.msg_id) || 0) : 0, job?.sentCount || 0);
      if (job && !repliesOf(job)[seq - 1] && used >= cap - (final ? 0 : 1))
        return send(409, { ok: false, error: final ? 'QQ reply quota exhausted' : 'reserve at least one QQ message for the final reply', messages_remaining: Math.max(0, cap - used) });
      if (job) {
        try {
          const cached = store.beginReply(job, replyFingerprint(j, imgs.files), { seq, final });
          if (cached) return send(cached.status, cached.body);
        } catch { return send(503, { ok: false, error: 'cannot persist reply intent; no message sent' }); }
      }
      const complete = (status, body) => {
        if (job) {
          try { store.finishReply(job, status, body); }
          catch {
            job.reply.state = 'uncertain';
            return send(503, { ok: false, error: 'reply outcome could not be persisted; do not resend' });
          }
        }
        send(status, body);
      };
      try {
        const sentBefore = used;
        const plan = hasText ? planParts(j.content, j.type, j.msg_id, sentBefore) : { parts: [], total: 0, truncated: false };
        const imgSlots = Math.max(0, cap - sentBefore - plan.parts.length);
        const toSend = imgs.files.slice(0, imgSlots), imagesSent = [];
        const results = []; let failure = null;
        const reserve = () => {
          if (!job) return;
          if (store.now() >= job.deadline) throw new Error('QQ reply window expired');
          // Reserve each platform sequence durably before its side effect, including across restarts.
          const count = Math.max(job.sentCount || 0, api.seq.get(j.msg_id) || 0) + 1;
          if (count > cap) throw new Error('QQ reply quota exhausted');
          store.save({ ...job, sentCount: count }); job.sentCount = count;
          api.seq.set(j.msg_id, count - 1);
        };
        for (const part of plan.parts) {
          try { reserve(); results.push(await api.send(j.type, target, part, j.msg_id)); }
          catch (e) { failure = e; break; }
        }
        const parts_sent = results.length;
        if (!failure) for (const im of toSend) {
          try {
            const up = await api.uploadImage(j.type, target, im.buf, im.name);
            if (!up || !up.file_info) { const e = new Error('upload returned no file_info'); e.body = up; throw e; }
            reserve(); results.push(await api.sendMedia(j.type, target, up.file_info, j.msg_id)); imagesSent.push(im.name);
          } catch (e) { failure = e; break; }
        }
        const histText = [plan.parts.slice(0, parts_sent).join('')].concat(imagesSent.map(n => '[图片] ' + n)).filter(Boolean).join('\n');
        if (parts_sent || imagesSent.length) append(j.type, target, { role: 'bot', nickname: null, member_role: null, openid: null,
          content: histText, timestamp: new Date().toISOString(), ...(job ? { reply_kind: final ? 'final' : 'progress', job_id: job.id, reply_seq: seq } : {}) });
        log('reply done', j.type, j.msg_id || '(active)', parts_sent + '/' + plan.total + (plan.truncated ? ' truncated' : ''));
        const body = { ok: !failure, parts_sent, parts_total: plan.total, truncated: plan.truncated,
          result: results.length ? results[0] : null, results };
        if (job) Object.assign(body, { reply_seq: seq, final, messages_used: job.sentCount || 0,
          messages_remaining: Math.max(0, cap - (job.sentCount || 0)), ...(!final && !failure ? { next_reply_seq: seq + 1 } : {}) });
        if (hasImg) Object.assign(body, { images_sent: imagesSent.length, images_total: imgs.files.length, images_skipped: imgs.files.length - toSend.length });
        if (failure) { log('reply failed', failure.message, JSON.stringify(failure.body || ''));
          return complete(502, { ...body, ok: false, error: failure.message, detail: failure.body }); }
        complete(200, body);
      } catch (e) { log('reply failed', e.message, JSON.stringify(e.body || '')); complete(502, { ok: false, error: e.message, detail: e.body }); }
    });
  });
}
module.exports = { createReplyServer, splitContent, planParts, loadImages, IMAGE_MAX };
