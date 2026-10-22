'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { MEDIA_LIMITS, validMedia, uploadId, voiceFormat } = require('./outbound_format');
const closed = job => job.reply?.state === 'uncertain' || job.reply?.state === 'sending'
  || (job.reply?.state === 'done' && (job.reply.final !== false || !job.reply.body?.ok));
function error(status, message) { return Object.assign(new Error(message), { status }); }
// Files live inside the private queue directory, so its lock/backup cover them.
function directory(dir, create = false) {
  const root = fs.realpathSync(dir), candidate = path.join(root, 'outbound');
  if (create) fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(candidate).isDirectory() || fs.lstatSync(candidate).isSymbolicLink() || fs.realpathSync(candidate) !== candidate)
    throw Object.assign(error(503, 'invalid outbound storage'), { code: 'EOUTBOUNDSTATE' });
  return candidate;
}
function checkOutboundStorage(dir) {
  try { const root = directory(dir); fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function removeJobUploads(dir, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid cleanup ID');
  let root;
  try { root = directory(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of fs.readdirSync(root)) if (new RegExp('^' + id + '\\.[a-f0-9]{64}\\.bin$').test(name))
    fs.unlinkSync(path.join(root, name));
}
function cleanupTemporaryUploads(dir) {
  let root;
  try { root = directory(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  // Call only after acquiring the queue instance lock: no upload can be live.
  for (const name of fs.readdirSync(root)) if (/^[a-f0-9]{64}\.[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.part$/.test(name))
    fs.unlinkSync(path.join(root, name));
}
class OutboundStore {
  constructor(store) { this.store = store; this.active = new Set(); }
  filename(job, id, create = false) { return path.join(directory(this.store.dir, create), job.id + '.' + id + '.bin'); }
  describe(job, id) {
    const item = job.uploads?.[id];
    if (!item) throw error(404, 'unknown upload');
    return { upload_id: id, ...item };
  }
  resolve(job, refs) {
    if (refs === undefined) return [];
    if (!Array.isArray(refs) || !refs.length || refs.length > MEDIA_LIMITS.count) throw error(400, 'media must contain 1 to 5 upload references');
    return refs.map(ref => {
      if (!ref || Object.keys(ref).some(key => key !== 'upload_id') || typeof ref.upload_id !== 'string' || !/^[a-f0-9]{64}$/.test(ref.upload_id))
        throw error(400, 'media entries require only upload_id');
      return this.describe(job, ref.upload_id);
    });
  }
  source(job, item) {
    if (!item.upload_id) return item;
    const file = this.filename(job, item.upload_id), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) throw error(409, 'uploaded media missing or changed');
    return { ...item, path: file };
  }
  handle(req, send, job, id) {
    if (req.method === 'GET') {
      try { send(200, { ok: true, media: this.describe(job, id) }); }
      catch (e) { send(e.status || 503, { ok: false, error: e.status ? e.message : 'cannot read upload' }); }
    } else if (req.method === 'PUT') {
      this.upload(req, job, id).then(result => send(200, result), e => {
        req.resume(); send(e.status || 503, { ok: false, error: e.status ? e.message : 'media upload failed; inspect status before retrying' });
      });
    } else send(405, { ok: false, error: 'method not allowed' });
  }
  async upload(req, job, id) {
    let name;
    try {
      if (typeof req.headers['x-media-name'] !== 'string') throw new Error();
      name = decodeURIComponent(req.headers['x-media-name']);
    } catch { throw error(400, 'invalid media name'); }
    const item = { kind: req.headers['x-media-kind'], name, sha256: req.headers['x-content-sha256'], bytes: Number(req.headers['content-length']) };
    if (req.headers['content-type'] !== 'application/octet-stream' || !validMedia(item) || uploadId(item) !== id)
      throw error(400, 'invalid upload metadata, size or content type');
    if (closed(job)) throw error(409, 'reply is sending or closed; do not upload');
    if (this.store.now() >= job.deadline) throw error(410, 'job expired');
    if (job.uploads?.[id]) { this.source(job, this.describe(job, id)); req.resume(); return { ok: true, replayed: true, media: this.describe(job, id) }; }
    if (this.active.has(job.id)) throw error(409, 'another upload for this job is in progress');
    if (this.active.size >= 4) throw error(503, 'upload capacity busy');
    const entries = Object.values(job.uploads || {});
    const usage = new Map(Object.entries(job.uploads || {}).map(([key, e]) => [key, e.bytes]));
    const root = directory(this.store.dir, true), pattern = new RegExp('^' + job.id + '\\.([a-f0-9]{64})\\.bin$');
    for (const name of fs.readdirSync(root)) {
      const match = pattern.exec(name); if (!match) continue;
      const stat = fs.lstatSync(path.join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw error(503, 'invalid outbound storage');
      usage.set(match[1], Math.max(usage.get(match[1]) || 0, stat.size));
    }
    usage.set(id, item.bytes);
    if (entries.length >= MEDIA_LIMITS.count || usage.size > MEDIA_LIMITS.count || [...usage.values()].reduce((a, b) => a + b, 0) > MEDIA_LIMITS.jobBytes)
      throw error(413, 'job upload quota exceeded');
    this.active.add(job.id);
    let handle, temp;
    const timer = setTimeout(() => req.destroy(), Math.min(MEDIA_LIMITS.uploadTimeoutMs, job.deadline - this.store.now()));
    timer.unref();
    try {
      const file = this.filename(job, id, true);
      temp = file + '.' + crypto.randomUUID() + '.part';
      handle = await fs.promises.open(temp, 'wx', 0o600);
      const hash = crypto.createHash('sha256'); let bytes = 0, head = Buffer.alloc(0);
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > item.bytes) throw error(413, 'upload exceeds declared size');
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset);
          if (!bytesWritten) throw error(503, 'cannot write media upload');
          offset += bytesWritten;
        }
      }
      if (bytes !== item.bytes || hash.digest('hex') !== item.sha256) throw error(400, 'upload size or checksum mismatch');
      if (item.kind === 'voice' && !voiceFormat(item.name, head)) throw error(400, 'voice requires matching SILK/WAV/MP3/FLAC content and extension');
      if (this.store.now() >= job.deadline) throw error(410, 'job expired');
      if (closed(job)) throw error(409, 'reply state changed during upload');
      await handle.sync(); await handle.close(); handle = null;
      await fs.promises.rename(temp, file); temp = null;
      if (process.platform === 'linux') {
        const parent = await fs.promises.open(path.dirname(file), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      if (this.store.now() >= job.deadline) throw error(410, 'job expired');
      if (closed(job)) throw error(409, 'reply state changed during upload');
      const next = { ...job, uploads: { ...job.uploads, [id]: item } };
      this.store.save(next); Object.assign(job, next);
      return { ok: true, replayed: false, media: this.describe(job, id) };
    } finally {
      clearTimeout(timer);
      try { await handle?.close(); } finally {
        if (temp) await fs.promises.unlink(temp).catch(() => {});
        this.active.delete(job.id);
      }
      // A renamed file whose registry write failed is deliberately retained.
      // It is never addressable without a durable registry entry; a retry can replace it.
    }
  }
}
module.exports = { OutboundStore, removeJobUploads, cleanupTemporaryUploads, checkOutboundStorage };
