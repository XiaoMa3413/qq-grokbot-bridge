'use strict';
const fs = require('fs'), path = require('path');
const DEFAULT_DIR = path.join(__dirname, 'data', 'history');
const MAX_CONTENT = 2000;
const DEFAULT_C2C = 20, DEFAULT_GROUP = 10;
function log(...a) { console.log(new Date().toISOString(), ...a); }
function historyDir() { return process.env.QQ_HISTORY_DIR || DEFAULT_DIR; }
function sanitize(s, max) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max); }
function historyKey(type, id) {
  const t = sanitize(type, 64), i = sanitize(id, 200);
  return (t || 'unknown') + '-' + (i || 'unknown');
}
function historyFile(type, id) { return path.join(historyDir(), historyKey(type, id) + '.jsonl'); }
function prim(v) { return v == null ? null : (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? v : String(v); }
function parseLine(l) { try { const e = JSON.parse(l); return e && typeof e.content === 'string' ? e : null; } catch { return null; } }
function parseEntries(raw) { return String(raw || '').split('\n').filter(Boolean).map(parseLine).filter(Boolean); }
function normalizeEntry(e) {
  const x = e || {};
  const out = { role: x.role === 'bot' ? 'bot' : 'user', nickname: prim(x.nickname), member_role: prim(x.member_role),
    openid: prim(x.openid), content: String(x.content == null ? '' : x.content).slice(0, MAX_CONTENT),
    timestamp: x.timestamp == null || x.timestamp === '' ? new Date().toISOString() : String(x.timestamp) };
  if (x.id != null && x.id !== '') out.id = prim(x.id); // optional; only present when the source carries one
  if (x.msg_id != null && x.msg_id !== '') out.msg_id = prim(x.msg_id); // optional; only present when the source carries one
  for (const key of ['reply_to_msg_id', 'reply_to_openid']) if (typeof x[key] === 'string' && x[key]) out[key] = x[key];
  if (x.source === 'qq_recent_context') out.source = x.source;
  const originalLength = Math.max(String(x.content ?? '').length, Number.isSafeInteger(x.original_content_chars) ? x.original_content_chars : 0);
  if (originalLength > out.content.length || x.content_truncated === true) {
    out.content_truncated = true; out.original_content_chars = originalLength;
  }
  if (x.role === 'bot' && ['progress', 'final'].includes(x.reply_kind)) {
    out.reply_kind = x.reply_kind;
    if (typeof x.job_id === 'string') out.job_id = x.job_id;
    if (Number.isInteger(x.reply_seq)) out.reply_seq = x.reply_seq;
  }
  return out;
}
// Per-type entry limits, read from config.json (historyLimitC2c / historyLimitGroup), defaulting to 20 / 10.
function positive(v, dflt) { const n = +v; return Number.isSafeInteger(n) && n > 0 && n <= 1000 ? n : dflt; }
function configLimits() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return { c2c: positive(c.historyLimitC2c, DEFAULT_C2C), group: positive(c.historyLimitGroup, DEFAULT_GROUP) };
  } catch (e) { return { c2c: DEFAULT_C2C, group: DEFAULT_GROUP }; }
}
function historyLimit(type) { const l = configLimits(); return type === 'group' ? l.group : l.c2c; }
function trimAt(type) { return historyLimit(type) + 10; }
function getHistory(type, id) {
  try { return parseEntries(fs.readFileSync(historyFile(type, id), 'utf8')).filter(e => e.reply_kind !== 'progress').slice(-historyLimit(type)); }
  catch (e) { if (e.code !== 'ENOENT') log('history read error', historyFile(type, id), e.message); return []; }
}
// Read every entry in the file (untouched by the per-type limit) for mergeRecent dedup.
function readAll(type, id, { strict = false } = {}) {
  try { return parseEntries(fs.readFileSync(historyFile(type, id), 'utf8')); }
  catch (e) { if (strict && e.code !== 'ENOENT') throw e; if (e.code !== 'ENOENT') log('history read error', historyFile(type, id), e.message); return []; }
}
function append(type, id, entry) {
  try {
    const f = historyFile(type, id), e = normalizeEntry(entry);
    const limit = historyLimit(type), trim = trimAt(type);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(e) + '\n');
    let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch (er) { log('history read error', f, er.message); }
    const lines = parseEntries(raw);
    if (lines.length > trim) {
      const keep = new Set([...lines.filter(x => x.reply_kind !== 'progress').slice(-limit),
        ...lines.filter(x => x.reply_kind === 'progress').slice(-5)]);
      const questions = new Set([...keep].filter(x => x.role === 'bot').map(x => x.reply_to_msg_id).filter(Boolean));
      for (const line of lines) if (line.role === 'user' && questions.has(line.msg_id)) keep.add(line);
      fs.writeFileSync(f, lines.filter(x => keep.has(x)).map(x => JSON.stringify(x)).join('\n') + '\n');
    }
    return e;
  } catch (e) { log('history append error', e.message); return null; }
}
// Merge QQ's auto-attached recent-context items (parseRecentContext output) into
// history as role:user entries, skipping duplicates. Each item
// {author, content, attachments, timestamp?, msg_id?} becomes one entry; an
// attachment carrying a local_path contributes a '[图片] <path>' content line,
// exactly like a downloaded inbound image. A duplicate is any stored entry that
// shares the same msg_id (when both carry one) OR the same trimmed content with
// a compatible nickname (a null on either side matches) and a timestamp within
// windowMs. Non-duplicates are appended in order; the newly-added count is
// returned. History stays bounded by historyLimit through append().
function mergeRecent(type, id, items, windowMs = 600000) {
  if (!Array.isArray(items)) return 0;
  let added = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const lines = [String(item.content == null ? '' : item.content)];
    for (const a of attachments) if (a && a.local_path) lines.push('[图片] ' + a.local_path);
    const entry = {
      role: 'user', nickname: item.author || null, content: lines.join('\n'), source: 'qq_recent_context',
      timestamp: item.timestamp || new Date().toISOString(), msg_id: item.msg_id || null };
    const tMs = Date.parse(entry.timestamp);
    const dup = readAll(type, id).some(e => {
      const eMs = Date.parse(e.timestamp);
      const within = Number.isFinite(tMs) && Number.isFinite(eMs) && Math.abs(tMs - eMs) <= windowMs;
      const sameId = entry.msg_id != null && e.msg_id != null && String(entry.msg_id) === String(e.msg_id);
      const sameText = String(e.content || '').trim() === entry.content.trim()
        && (e.nickname == null || entry.nickname == null || e.nickname === entry.nickname) && within;
      return sameId || sameText;
    });
    if (!dup && append(type, id, entry)) added++;
  }
  return added;
}
module.exports = { getHistory, readAll, append, mergeRecent, historyKey, historyFile, historyDir, normalizeEntry, historyLimit, trimAt, MAX_CONTENT };
