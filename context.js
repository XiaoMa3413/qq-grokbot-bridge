'use strict';
const { CONTEXT_DEFAULTS, historyLimit } = require('./policy');
// Deterministic context assembly; no model calls or platform-memory access.
const stableId = value => typeof value === 'string' && value.length ? value : null;
function speakerId(payload) {
  return payload.type === 'c2c' ? stableId(payload.openid)
    : stableId(payload.author?.member_openid) || stableId(payload.author?.user_openid);
}
function clip(text, max) {
  let result = text.slice(0, Math.max(0, max));
  // Do not leave half a UTF-16 surrogate pair at the boundary.
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}
function fit(entries, budget) {
  let remaining = budget;
  const result = entries.map((entry, i) => {
    const content = typeof entry.content === 'string' ? entry.content : '';
    const allowance = Math.floor(remaining / (entries.length - i));
    const shortened = clip(content, allowance);
    remaining -= shortened.length;
    return { ...entry, content: shortened, ...(shortened.length < content.length ? {
      content_truncated: true, original_content_chars: Math.max(entry.original_content_chars || 0, content.length),
    } : {}) };
  });
  return result;
}
const chars = entries => entries.reduce((sum, e) => sum + e.content.length, 0);
function selectAux(input, budget, maxItems = 10) {
  const available = Array.isArray(input) ? input.filter(e => e && typeof e === 'object') : [];
  const entries = [];
  let remaining = budget;
  for (const entry of available.slice(0, maxItems)) {
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (content.length && remaining === 0 && !entry.attachments?.length) continue;
    const [bounded] = fit([{ ...entry, content }], remaining);
    entries.push(bounded); remaining -= bounded.content.length;
  }
  return { entries, meta: { available_entries: available.length, sent_entries: entries.length,
    omitted_entries: available.length - entries.length, truncated_entries: entries.filter(e => e.content_truncated).length } };
}
function assembleContext(payload, stored, { maxChars = CONTEXT_DEFAULTS.contextTextMaxChars, maxEntries = historyLimit(payload.type), historyAvailable = true } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new Error('invalid context budget');
  const speaker = speakerId(payload);
  const quotes = selectAux(payload.quoted, Math.min(4000, Math.floor(maxChars / 3)));
  const quoteIds = new Set(quotes.entries.map(e => stableId(e.msg_id)).filter(Boolean));
  const entries = (Array.isArray(stored) ? stored : []).filter(e => e && typeof e.content === 'string'
    && e.reply_kind !== 'progress' && !(stableId(payload.msg_id) && e.role !== 'bot' && e.msg_id === payload.msg_id)
    && !(stableId(payload.msg_id) && e.role === 'bot' && e.reply_to_msg_id === payload.msg_id));
  const users = new Map(), units = new Map();
  for (let index = 0; index < entries.length; index++) {
    const e = entries[index];
    if (e.role !== 'bot') {
      if (stableId(e.msg_id)) users.set(e.msg_id, index);
      units.set(index, { indices: [index] });
    }
  }
  let orphaned = 0;
  for (let index = 0; index < entries.length; index++) {
    const e = entries[index];
    if (e.role !== 'bot') continue;
    const userIndex = users.get(e.reply_to_msg_id);
    if (stableId(e.reply_to_msg_id)) {
      // Explicit links never fall back to a different question or a matching nickname.
      if (userIndex === undefined || userIndex >= index ||
          (stableId(e.reply_to_openid) && stableId(entries[userIndex].openid) && e.reply_to_openid !== entries[userIndex].openid)) {
        orphaned++; continue;
      }
      units.get(userIndex).indices.push(index);
    } else units.set(index, { indices: [index] }); // Legacy replies stay usable; association is unknown.
  }
  const ranked = [...units.values()].map(unit => {
    const records = unit.indices.map(i => entries[i]);
    const quoted = records.some(e => quoteIds.has(e.msg_id));
    const direct = payload.type === 'c2c' || !!speaker && records.some(e => e.role !== 'bot' && e.openid === speaker);
    return { ...unit, priority: quoted ? 2 : direct ? 1 : 0, last: Math.max(...unit.indices) };
  }).sort((a, b) => b.priority - a.priority || b.last - a.last);
  let remaining = maxChars - chars(quotes.entries), slots = maxEntries;
  const selected = new Map();
  for (const unit of ranked) {
    if (unit.indices.length > slots || remaining < unit.indices.length) continue;
    const originals = unit.indices.map(i => entries[i]);
    const bounded = chars(originals) <= remaining ? originals.map(e => ({ ...e })) : fit(originals, remaining);
    for (let i = 0; i < unit.indices.length; i++) selected.set(unit.indices[i], bounded[i]);
    remaining -= chars(bounded); slots -= bounded.length;
  }
  const history = [...selected].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  const rawRecent = Array.isArray(payload.recent_context) ? payload.recent_context : [];
  const uniqueRecent = rawRecent.filter(e => !e || e.attachments?.length || !history.some(h => h.content === e.content
    && (stableId(e.msg_id) && e.msg_id === h.msg_id
      || h.source === 'qq_recent_context' && !stableId(h.openid) && !stableId(e.openid) && h.nickname === (e.author || null))));
  const recent = selectAux(uniqueRecent, remaining);
  recent.meta.deduplicated_entries = rawRecent.length - uniqueRecent.length;
  recent.meta.available_entries += recent.meta.deduplicated_entries;
  recent.meta.omitted_entries += recent.meta.deduplicated_entries;
  const used = chars(quotes.entries) + chars(history) + chars(recent.entries);
  return { history, quoted: quotes.entries, recent_context: recent.entries, context: {
    schema: 1, conversation: { type: payload.type, id: payload.type === 'group' ? payload.group_openid : payload.openid },
    speaker: { id: speaker, nickname: stableId(payload.nickname) },
    budget: { max_chars: maxChars, used_chars: used, unit: 'utf16_code_units',
      excludes: ['current_message', 'memory', 'attachments', 'metadata'] },
    history: { available: historyAvailable, max_entries: maxEntries, available_entries: entries.length, sent_entries: history.length,
      omitted_entries: entries.length - history.length, orphaned_entries: orphaned,
      truncated_entries: history.filter(e => e.content_truncated).length,
      unlinked_bot_entries: history.filter(e => e.role === 'bot' && !stableId(e.reply_to_msg_id)).length },
    quoted: quotes.meta, recent_context: recent.meta,
    memory: { source: 'bridge_conversation', scope: payload.type === 'group' ? 'group' : 'private', platform_sync: 'not_configured' },
  } };
}
module.exports = { assembleContext, speakerId };
