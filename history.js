'use strict';
const fs = require('fs'), path = require('path');
const DEFAULT_DIR = path.join(__dirname, 'data', 'history');
const MAX_ENTRIES = 50, TRIM_AT = 60, MAX_CONTENT = 2000;
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
  return { role: x.role === 'bot' ? 'bot' : 'user', nickname: prim(x.nickname), member_role: prim(x.member_role),
    openid: prim(x.openid), content: String(x.content == null ? '' : x.content).slice(0, MAX_CONTENT),
    timestamp: x.timestamp == null || x.timestamp === '' ? new Date().toISOString() : String(x.timestamp) };
}
function getHistory(type, id) {
  try { return parseEntries(fs.readFileSync(historyFile(type, id), 'utf8')).slice(-MAX_ENTRIES); }
  catch (e) { if (e.code !== 'ENOENT') log('history read error', historyFile(type, id), e.message); return []; }
}
function append(type, id, entry) {
  try {
    const f = historyFile(type, id), e = normalizeEntry(entry);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(e) + '\n');
    let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch (er) { log('history read error', f, er.message); }
    const lines = parseEntries(raw);
    if (lines.length > TRIM_AT) fs.writeFileSync(f, lines.slice(-MAX_ENTRIES).map(x => JSON.stringify(x)).join('\n') + '\n');
    return e;
  } catch (e) { log('history append error', e.message); return null; }
}
module.exports = { getHistory, append, historyKey, historyFile, historyDir, normalizeEntry, MAX_ENTRIES, MAX_CONTENT, TRIM_AT };
