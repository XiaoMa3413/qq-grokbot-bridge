'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { replyConfiguration } = require('./reply-config');
const { validMedia, uploadId, MEDIA_LIMITS } = require('../outbound_format');
async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run upload-media -- --job <job_id> --kind <file|voice> --file <local-artifact> [--name <display-name>]\nUploads bytes only; does not send QQ. Use the returned upload_id in reply JSON media:[{upload_id:"..."}].'); return;
  }
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !['job', 'kind', 'file', 'name'].includes(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('arguments');
    options[key] = args[++i];
  }
  if (!/^[a-f0-9]{64}$/.test(options.job || '') || !options.file) throw new Error('arguments');
  const { url, token } = replyConfiguration();
  const stat = await fs.promises.stat(options.file);
  const media = { kind: options.kind, name: options.name || path.basename(options.file), bytes: stat.size, sha256: '0'.repeat(64) };
  if (!stat.isFile() || !validMedia(media)) throw new Error('invalid artifact');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(options.file)) hash.update(chunk);
  media.sha256 = hash.digest('hex');
  const id = uploadId(media), stream = fs.createReadStream(options.file);
  try {
    const response = await fetch(new URL(`/jobs/${options.job}/uploads/${id}`, url), { method: 'PUT', redirect: 'error', duplex: 'half',
      body: stream, signal: AbortSignal.timeout(MEDIA_LIMITS.uploadTimeoutMs), headers: { 'X-Reply-Token': token,
        'Content-Type': 'application/octet-stream', 'Content-Length': String(media.bytes), 'X-Media-Kind': media.kind,
        'X-Media-Name': encodeURIComponent(media.name), 'X-Content-SHA256': media.sha256 } });
    let text = '';
    for await (const chunk of response.body) { text += Buffer.from(chunk).toString('utf8'); if (text.length > 8192) throw new Error('response too large'); }
    const result = JSON.parse(text);
    if (!response.ok || result?.ok !== true || result.media?.upload_id !== id) throw new Error('upload rejected');
    // Print our checked metadata, not an arbitrary proxy response.
    console.log(JSON.stringify({ ok: true, replayed: result.replayed === true, media: { upload_id: id, ...media } }));
  } finally { stream.destroy(); }
}
main().catch(() => {
  console.error(JSON.stringify({ ok: false, error: 'upload failed; check arguments, artifact, credentials and task upload status (--help); no QQ message was sent by this command' }));
  process.exitCode = 1;
});
