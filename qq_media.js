'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const { MEDIA_LIMITS, sha256, validName, voiceFormat } = require('./outbound_format');
function mediaError(cause) {
  const error = new Error('QQ media upload failed; check media permission, format, quota and deadline');
  error.code = 'EMEDIAUPLOAD';
  const code = cause?.body?.code ?? cause?.body?.err_code;
  error.body = { ...(Number.isInteger(cause?.status) ? { http_status: cause.status } : {}),
    ...(Number.isInteger(code) ? { code } : {}) };
  return error;
}
function presignedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || !url.hostname.endsWith('.myqcloud.com')) throw new Error('invalid COS upload URL');
  return url;
}
async function uploadMedia(api, type, target, media, { deadline = Infinity, now = Date.now, put } = {}) {
  let handle;
  const checkTime = () => { if (now() >= deadline) throw new Error('deadline'); };
  const endpoint = `/v2/${type === 'c2c' ? 'users' : 'groups'}/${encodeURIComponent(target)}`;
  try {
    if (!['c2c', 'group'].includes(type) || !['file', 'voice'].includes(media.kind) || !validName(media.name)) throw new Error('invalid media');
    const fileType = media.kind === 'voice' ? 3 : 4;
    let size = media.buf?.length;
    if (!media.buf) {
      handle = await fs.promises.open(media.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat(); if (!stat.isFile()) throw new Error('invalid media source');
      size = stat.size;
    }
    if (!Number.isSafeInteger(size) || size < 1 || size > (media.kind === 'voice' ? MEDIA_LIMITS.voiceBytes : MEDIA_LIMITS.fileBytes)) throw new Error('media too large');
    const read = async (offset, length) => {
      if (media.buf) return media.buf.subarray(offset, offset + length);
      const buffer = Buffer.alloc(length); let count = 0;
      while (count < length) {
        const { bytesRead } = await handle.read(buffer, count, length - count, offset + count);
        if (!bytesRead) throw new Error('media changed'); count += bytesRead;
      }
      return buffer;
    };
    const head = await read(0, Math.min(size, 16));
    if (media.kind === 'voice' && !voiceFormat(media.name, head)) throw new Error('invalid voice');
    checkTime();
    if (size < MEDIA_LIMITS.inlineBytes) {
      const buf = await read(0, size);
      if (sha256(buf) !== media.sha256) throw new Error('media checksum changed');
      const result = await api.req('POST', endpoint + '/files', { file_type: fileType, file_data: buf.toString('base64'),
        ...(fileType === 4 ? { file_name: media.name } : {}), srv_send_msg: false });
      if (typeof result?.file_info !== 'string' || !result.file_info) throw Object.assign(new Error('missing file_info'), { body: result });
      return result;
    }
    const hashes = Object.fromEntries(['md5', 'sha1', 'sha256', 'md5_10m'].map(key => [key, crypto.createHash(key === 'md5_10m' ? 'md5' : key)]));
    for (let offset = 0; offset < size; offset += 1024 * 1024) {
      checkTime(); const chunk = await read(offset, Math.min(1024 * 1024, size - offset));
      for (const key of ['md5', 'sha1', 'sha256']) hashes[key].update(chunk);
      if (offset < 10002432) hashes.md5_10m.update(chunk.subarray(0, 10002432 - offset));
    }
    const checksums = Object.fromEntries(Object.entries(hashes).map(([key, hash]) => [key, hash.digest('hex')]));
    if (checksums.sha256 !== media.sha256) throw new Error('media checksum changed');
    checkTime();
    const prepared = await api.req('POST', endpoint + '/upload_prepare', { file_type: fileType, file_name: media.name, file_size: size,
      md5: checksums.md5, sha1: checksums.sha1, md5_10m: checksums.md5_10m });
    const block = prepared?.block_size, parts = prepared?.parts;
    if (typeof prepared?.upload_id !== 'string' || !prepared.upload_id || prepared.upload_id.length > 2048
      || !Number.isSafeInteger(block) || block < 1 || block > MEDIA_LIMITS.fileBytes || !Array.isArray(parts)
      || parts.length !== Math.ceil(size / block) || parts.length > 1000) throw Object.assign(new Error('invalid upload preparation'), { body: prepared });
    const ordered = [...parts].sort((a, b) => a.index - b.index);
    const urls = ordered.map((part, i) => { if (part.index !== i + 1) throw new Error('invalid part index'); return presignedUrl(part.presigned_url); });
    const uploadedHash = crypto.createHash('sha256');
    for (const [i, part] of ordered.entries()) {
      checkTime();
      const offset = (part.index - 1) * block, chunk = await read(offset, Math.min(block, size - offset));
      uploadedHash.update(chunk);
      checkTime();
      await put(urls[i], chunk, Math.min(30000, deadline - now()));
      checkTime();
      await api.req('POST', endpoint + '/upload_part_finish', { upload_id: prepared.upload_id, part_index: part.index,
        block_size: chunk.length, md5: crypto.createHash('md5').update(chunk).digest('hex') });
    }
    if (uploadedHash.digest('hex') !== media.sha256) throw new Error('media changed during upload');
    checkTime();
    const result = await api.req('POST', endpoint + '/files', { upload_id: prepared.upload_id });
    if (typeof result?.file_info !== 'string' || !result.file_info) throw Object.assign(new Error('missing file_info'), { body: result });
    return result;
  } catch (cause) { throw mediaError(cause); }
  finally { await handle?.close(); }
}
module.exports = { uploadMedia, mediaError, presignedUrl };
