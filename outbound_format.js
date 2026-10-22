'use strict';
const crypto = require('node:crypto');
const MEDIA_LIMITS = Object.freeze({ inlineBytes: 5 * 1024 * 1024, fileBytes: 100 * 1024 * 1024,
  voiceBytes: 20 * 1024 * 1024, jobBytes: 100 * 1024 * 1024, count: 5, uploadTimeoutMs: 120000 });
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const uploadId = ({ kind, name, sha256: hash }) => sha256(JSON.stringify([kind, name, hash]));
function validName(name) {
  return typeof name === 'string' && name.trim() === name && name.length > 0 && Buffer.byteLength(name) <= 180
    && !/[\x00-\x1f\x7f/\\<>:"|?*]/.test(name) && !['.', '..'].includes(name);
}
function validMedia(item) {
  return item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).every(key => ['kind', 'name', 'sha256', 'bytes'].includes(key))
    && ['file', 'voice'].includes(item.kind) && validName(item.name)
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)
    && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= (item.kind === 'voice' ? MEDIA_LIMITS.voiceBytes : MEDIA_LIMITS.fileBytes);
}
function voiceFormat(name, head) {
  const ext = name.split('.').at(-1).toLowerCase();
  if (ext === 'silk' && (head.subarray(0, 9).toString() === '#!SILK_V3' || head.subarray(0, 10).toString() === '\x02#!SILK_V3')) return 'silk';
  if (ext === 'wav' && head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (ext === 'mp3' && (head.subarray(0, 3).toString() === 'ID3' || (head.length >= 2 && head[0] === 255 && (head[1] & 0xe0) === 0xe0))) return 'mp3';
  if (ext === 'flac' && head.subarray(0, 4).toString() === 'fLaC') return 'flac';
  return null;
}
function decodeMedia(body) {
  if (body.media_base64 === undefined) return { files: [] };
  if (!Array.isArray(body.media_base64) || !body.media_base64.length || body.media_base64.length > MEDIA_LIMITS.count)
    return { error: 'media_base64 must contain 1 to 5 file/voice items' };
  const files = []; let bytes = 0;
  for (const item of body.media_base64) {
    if (!item || !['file', 'voice'].includes(item.kind) || !validName(item.name) || typeof item.data !== 'string' || !item.data
      || item.data.length > Math.ceil(MEDIA_LIMITS.inlineBytes / 3) * 4 || item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data))
      return { error: 'invalid media kind, name or base64' };
    const buf = Buffer.from(item.data, 'base64'); bytes += buf.length;
    if (buf.toString('base64') !== item.data || bytes > MEDIA_LIMITS.inlineBytes) return { error: 'invalid base64 or inline media exceeds 5 MiB' };
    if (item.kind === 'voice' && !voiceFormat(item.name, buf)) return { error: 'voice requires matching SILK/WAV/MP3/FLAC content and extension' };
    files.push({ kind: item.kind, name: item.name, sha256: sha256(buf), bytes: buf.length, buf });
  }
  return { files };
}
module.exports = { MEDIA_LIMITS, sha256, uploadId, validName, validMedia, voiceFormat, decodeMedia };
