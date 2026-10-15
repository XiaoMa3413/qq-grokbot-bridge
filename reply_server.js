'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { log } = require('./lib');
const { append } = require('./history');
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
function createReplyServer(api, token) {
  return http.createServer((req, res) => {
    const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/reply') return send(404, { ok: false, error: 'not found' });
    if (req.headers['x-reply-token'] !== token) return send(401, { ok: false, error: 'bad token' });
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let j; try { j = JSON.parse(b); } catch { return send(400, { ok: false, error: 'invalid json' }); }
      const target = j.type === 'c2c' ? j.openid : j.type === 'group' ? j.group_openid : null;
      const hasText = typeof j.content === 'string' && j.content.length > 0;
      const hasImg = j.image !== undefined || j.images !== undefined;
      if (!target || (!hasText && !hasImg) || (j.content !== undefined && typeof j.content !== 'string'))
        return send(400, { ok: false, error: 'need type(c2c|group), openid|group_openid, content and/or image(s)' });
      const imgs = loadImages(j);
      if (imgs.error) return send(400, { ok: false, error: imgs.error });
      try {
        const sentBefore = j.msg_id ? (api.seq.get(j.msg_id) || 0) : 0;
        const plan = hasText ? planParts(j.content, j.type, j.msg_id, sentBefore) : { parts: [], total: 0, truncated: false };
        const cap = j.msg_id ? (PASSIVE_CAP[j.type] || ACTIVE_MAX) : ACTIVE_MAX;
        const imgSlots = Math.max(0, cap - sentBefore - plan.parts.length);
        const toSend = imgs.files.slice(0, imgSlots), imagesSent = [];
        const results = []; let failure = null;
        for (const part of plan.parts) {
          try { results.push(await api.send(j.type, target, part, j.msg_id)); }
          catch (e) { failure = e; break; }
        }
        const parts_sent = results.length;
        if (!failure) for (const im of toSend) {
          try {
            const up = await api.uploadImage(j.type, target, im.buf, im.name);
            if (!up || !up.file_info) { const e = new Error('upload returned no file_info'); e.body = up; throw e; }
            results.push(await api.sendMedia(j.type, target, up.file_info, j.msg_id)); imagesSent.push(im.name);
          } catch (e) { failure = e; break; }
        }
        const histText = [plan.parts.slice(0, parts_sent).join('')].concat(imagesSent.map(n => '[图片] ' + n)).filter(Boolean).join('\n');
        if (parts_sent || imagesSent.length) append(j.type, target, { role: 'bot', nickname: null, member_role: null, openid: null,
          content: histText, timestamp: new Date().toISOString() });
        log('reply done', j.type, j.msg_id || '(active)', parts_sent + '/' + plan.total + (plan.truncated ? ' truncated' : ''));
        const body = { ok: !failure, parts_sent, parts_total: plan.total, truncated: plan.truncated,
          result: results.length ? results[0] : null, results };
        if (hasImg) Object.assign(body, { images_sent: imagesSent.length, images_total: imgs.files.length, images_skipped: imgs.files.length - toSend.length });
        if (failure) { log('reply failed', failure.message, JSON.stringify(failure.body || ''));
          return send(502, { ...body, ok: false, error: failure.message, detail: failure.body }); }
        send(200, body);
      } catch (e) { log('reply failed', e.message, JSON.stringify(e.body || '')); send(502, { ok: false, error: e.message, detail: e.body }); }
    });
  });
}
module.exports = { createReplyServer, splitContent, planParts, loadImages, IMAGE_MAX };
