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
  return { role: x.role === 'bot' ? 'bot' : 'user', nickname: prim(x.nickname), member_role: prim(x.member_role),
    openid: prim(x.openid), content: String(x.content == null ? '' : x.content).slice(0, MAX_CONTENT),
    timestamp: x.timestamp == null || x.timestamp === '' ? new Date().toISOString() : String(x.timestamp) };
}
// Per-type entry limits, read from config.json (historyLimitC2c / historyLimitGroup), defaulting to 20 / 10.
function positive(v, dflt) { const n = +v; return Number.isFinite(n) && n > 0 ? n : dflt; }
function configLimits() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return { c2c: positive(c.historyLimitC2c, DEFAULT_C2C), group: positive(c.historyLimitGroup, DEFAULT_GROUP) };
  } catch (e) { return { c2c: DEFAULT_C2C, group: DEFAULT_GROUP }; }
}
function historyLimit(type) { const l = configLimits(); return type === 'group' ? l.group : l.c2c; }
function trimAt(type) { return historyLimit(type) + 10; }
function getHistory(type, id) {
  try { return parseEntries(fs.readFileSync(historyFile(type, id), 'utf8')).slice(-historyLimit(type)); }
  catch (e) { if (e.code !== 'ENOENT') log('history read error', historyFile(type, id), e.message); return []; }
}
function append(type, id, entry) {
  try {
    const f = historyFile(type, id), e = normalizeEntry(entry);
    const limit = historyLimit(type), trim = trimAt(type);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(e) + '\n');
    let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch (er) { log('history read error', f, er.message); }
    const lines = parseEntries(raw);
    if (lines.length > trim) fs.writeFileSync(f, lines.slice(-limit).map(x => JSON.stringify(x)).join('\n') + '\n');
    return e;
  } catch (e) { log('history append error', e.message); return null; }
}
module.exports = { getHistory, append, historyKey, historyFile, historyDir, normalizeEntry, historyLimit, trimAt, MAX_CONTENT };
