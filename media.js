'use strict';
const fs = require('fs'), path = require('path');
const { log } = require('./lib');
const MAX_BYTES = 20 * 1024 * 1024, TIMEOUT_MS = 15000;
function mediaDir() { return process.env.QQ_MEDIA_DIR || path.join(__dirname, 'data', 'media'); }
function sanitize(s, max) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max); }
function extFor(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('png')) return 'png';
  if (t.includes('gif')) return 'gif';
  if (t.includes('webp')) return 'webp';
  return 'bin';
}
function absolutize(u) { return u.startsWith('//') ? 'https:' + u : u; }
async function fetchToFile(url, dest) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('image too large: ' + declared);
    const parts = []; let total = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) throw new Error('image too large: ' + total);
        parts.push(Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error('image too large: ' + buf.length);
      parts.push(buf);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.concat(parts));
    return path.resolve(dest);
  } finally { clearTimeout(timer); }
}
// Download every image attachment of an inbound payload into QQ_MEDIA_DIR and set attachment.local_path
// (absolute path on success, null on failure). Never throws: one bad image never blocks the message.
async function downloadImages(payload) {
  const atts = payload && Array.isArray(payload.attachments) ? payload.attachments : [];
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    if (!a || typeof a.content_type !== 'string' || !a.content_type.startsWith('image/')) continue;
    const dest = path.join(mediaDir(), (sanitize(payload && payload.msg_id, 200) || 'msg') + '-' + i + '.' + extFor(a.content_type));
    const url = typeof a.url === 'string' && a.url ? a.url : null;
    if (!url) { a.local_path = null; continue; }
    try { a.local_path = await fetchToFile(absolutize(url), dest); log('media saved', a.local_path); }
    catch (e) { a.local_path = null; log('media download failed', url, e.message); }
  }
  return payload;
}
module.exports = { downloadImages };
