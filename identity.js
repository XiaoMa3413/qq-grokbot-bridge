'use strict';

const stableId = value => typeof value === 'string' && value.length ? value : null;
// role:bot belongs to bridge-written reply history, never to an external quote.
function isSelfReply(entry) {
  return entry.role === 'bot' && !['qq_recent_context', 'qq_quote'].includes(entry.source);
}
function attributionFor(entry, { self = false, nickname = entry.nickname } = {}) {
  const id = self ? null : stableId(entry.openid), name = self ? null : stableId(nickname);
  return {
    speaker: self ? 'self' : id ? 'other' : 'unknown', id, nickname: name,
    is_bot: self ? true : typeof entry.author_bot === 'boolean' ? entry.author_bot : null,
    basis: self ? 'bridge_reply_history' : id ? 'qq_author_id' : name ? 'display_name_only' : 'unavailable',
  };
}
module.exports = { stableId, isSelfReply, attributionFor };
