'use strict';
const fs = require('fs'), path = require('path');
const { digest, targetOf, atomicFile, repliesOf, replyClosed } = require('./jobs');
const { memoryPath, memoryDir } = require('./memory');
const IMAGE_LIMIT = 5 * 1024 * 1024, MEMORY_LIMIT = 64 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function decodeImages(body) {
  if (body.images_base64 === undefined) return { files: [] };
  if (!Array.isArray(body.images_base64) || !body.images_base64.length || body.images_base64.length > 5)
    return { error: 'images_base64 must contain 1 to 5 PNG/JPEG images' };
  const files = []; let bytes = 0;
  for (const [i, image] of body.images_base64.entries()) {
    if (!image || typeof image.data !== 'string' || !image.data || image.data.length > Math.ceil(IMAGE_LIMIT / 3) * 4 ||
      image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return { error: 'invalid image base64' };
    const buf = Buffer.from(image.data, 'base64');
    if (buf.toString('base64') !== image.data) return { error: 'invalid image base64' };
    bytes += buf.length;
    if (bytes > IMAGE_LIMIT) return { error: 'combined image data exceeds 5 MiB' };
    const ext = buf.subarray(0, 8).equals(PNG) ? 'png' : buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255 ? 'jpg' : null;
    if (!ext) return { error: 'only PNG/JPEG image data is accepted' };
    const name = image.name || `image-${i + 1}.${ext}`;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}\.(png|jpe?g)$/i.test(name) ||
      (ext === 'png' ? !/\.png$/i.test(name) : !/\.jpe?g$/i.test(name))) return { error: 'invalid image name or extension' };
    files.push({ name, buf });
  }
  return { files };
}
function replyFingerprint(body, files) {
  return digest(JSON.stringify({ content: body.content || '', images: files.map(f => [f.name, digest(f.buf)]) }));
}
function readMemory(payload) {
  const file = fs.realpathSync(memoryPath(payload.type, targetOf(payload)));
  const relative = path.relative(fs.realpathSync(memoryDir()), file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('memory outside configured directory');
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > MEMORY_LIMIT) throw new Error('invalid memory file or memory exceeds 64 KiB');
  const content = fs.readFileSync(file, 'utf8');
  return { file, content, etag: '"' + digest(content) + '"' };
}
class RemoteAccess {
  constructor(store, publicUrl, { mediaRoot = process.env.QQ_MEDIA_DIR || path.join(__dirname, 'data', 'media') } = {}) {
    this.store = store; this.origin = new URL(publicUrl).origin; this.mediaRoot = path.resolve(mediaRoot);
  }
  assetPath(file) {
    const resolved = fs.realpathSync(file), root = fs.realpathSync(this.mediaRoot);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('media outside configured directory');
    if (!/\.(png|jpe?g|gif|webp)$/i.test(resolved) || !fs.statSync(resolved).isFile() || fs.statSync(resolved).size > 20 * 1024 * 1024)
      throw new Error('invalid media file');
    return resolved;
  }
  payload(payload, job) {
    const walk = value => {
      if (Array.isArray(value)) return value.map(walk);
      if (!value || typeof value !== 'object') return value;
      const out = Object.create(null);
      for (const [key, item] of Object.entries(value)) if (!['local_path', 'memory_path'].includes(key)) out[key] = walk(item);
      if (value.local_path) {
        try {
          const file = this.assetPath(value.local_path), id = digest(file);
          job.assets[id] = file; out.download_url = `${this.origin}/jobs/${job.id}/media/${id}`;
        } catch { /* A missing cached image must not prevent a text reply. */ }
      }
      return out;
    };
    const result = walk(payload), memory = readMemory(payload);
    for (const entry of result.history || []) if (typeof entry.content === 'string')
      entry.content = entry.content.replace(/\[图片\] ([^\r\n]+)/g, (_, file) => '[图片] ' + file.split(/[\\/]/).pop());
    result.job_id = job.id; result.reply_url = this.origin + '/reply';
    result.memory_url = `${this.origin}/jobs/${job.id}/memory`;
    result.memory = { content: memory.content, etag: memory.etag };
    result.reply_deadline = new Date(job.deadline).toISOString();
    result.reply_policy = { segmented: true, next_reply_seq: repliesOf(job).length + 1,
      message_limit: payload.type === 'group' ? 5 : 4, progress_max_chars: 1500, reserve_final: 1 };
    return result;
  }
  handle(req, res, send) {
    if (!req.url.startsWith('/jobs/')) return false;
    const match = /^\/jobs\/([a-f0-9]{64})(?:\/(memory|media)(?:\/([a-f0-9]{64}))?)?$/.exec(req.url);
    if (!match) { send(404, { ok: false, error: 'not found' }); return true; }
    const job = this.store.get(match[1]);
    if (!job) { send(404, { ok: false, error: 'unknown job' }); return true; }
    if (this.store.now() >= job.deadline) { send(410, { ok: false, error: 'job expired' }); return true; }
    try {
      if (!match[2] && req.method === 'GET') {
        send(200, { ok: true, job_id: job.id, delivery: job.delivery, attempts: job.attempts,
          reply: job.reply?.state === 'done' && !replyClosed(job) ? 'awaiting_final' : job.reply?.state || 'pending', reply_http_status: job.reply?.httpStatus || null,
          reply_final: !!job.reply && job.reply.final !== false, reply_closed: replyClosed(job), next_reply_seq: repliesOf(job).length + 1,
          messages_used: job.sentCount || 0, messages_remaining: Math.max(0, (job.payload.type === 'group' ? 5 : 4) - (job.sentCount || 0)),
          replies: repliesOf(job).map(r => ({ reply_seq: r.seq || 1, final: r.final !== false, state: r.state, http_status: r.httpStatus || null })),
          last_error: job.lastError || null, deadline: new Date(job.deadline).toISOString() });
      } else if (match[2] === 'media' && match[3] && req.method === 'GET') {
        const file = job.assets[match[3]];
        if (!file) { send(404, { ok: false, error: 'unknown media' }); return true; }
        const safe = this.assetPath(file), ext = path.extname(safe).toLowerCase();
        res.writeHead(200, { 'Content-Type': ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[ext],
          'Content-Length': fs.statSync(safe).size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const stream = fs.createReadStream(safe); stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy()); stream.pipe(res);
      } else if (match[2] === 'memory' && !match[3] && req.method === 'GET') {
        const memory = readMemory(job.payload);
        res.setHeader('ETag', memory.etag); send(200, { ok: true, content: memory.content, etag: memory.etag });
      } else if (match[2] === 'memory' && !match[3] && req.method === 'PUT') {
        if (typeof req.headers['if-match'] !== 'string') { send(428, { ok: false, error: 'If-Match is required' }); return true; }
        let bytes = 0, chunks = [], tooLarge = false;
        req.on('data', c => {
          if (tooLarge) return;
          bytes += c.length;
          if (bytes > MEMORY_LIMIT * 6 + 1024) { tooLarge = true; chunks = []; send(413, { ok: false, error: 'memory too large' }); }
          else chunks.push(c);
        });
        req.on('end', () => {
          if (tooLarge) return;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || typeof body.content !== 'string') return send(400, { ok: false, error: 'need content string' });
            if (Buffer.byteLength(body.content) > MEMORY_LIMIT) return send(413, { ok: false, error: 'memory too large' });
            if (this.store.now() >= job.deadline) return send(410, { ok: false, error: 'job expired' });
            const current = readMemory(job.payload);
            if (req.headers['if-match'] !== current.etag) return send(412, { ok: false, error: 'memory changed; read and merge before retrying' });
            // Memory is plain Markdown, not the JSON file format used by jobs.
            atomicFile(current.file, body.content);
            const etag = '"' + digest(body.content) + '"'; res.setHeader('ETag', etag);
            send(200, { ok: true, etag });
          } catch { send(400, { ok: false, error: 'invalid memory request or storage failure' }); }
        });
      } else send(405, { ok: false, error: 'method not allowed' });
    } catch { send(404, { ok: false, error: 'resource unavailable' }); }
    return true;
  }
}
module.exports = { RemoteAccess, decodeImages, replyFingerprint, IMAGE_LIMIT, MEMORY_LIMIT };
