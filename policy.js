'use strict';

// Shared defaults and protocol limits used by validation, planning and payloads.
const CONTEXT_DEFAULTS = Object.freeze({ historyLimitC2c: 20, historyLimitGroup: 10, contextTextMaxChars: 12000 });
const REPLY_LIMITS = Object.freeze({
  textChars: 1500, segments: 5, reserveFinal: 1, activeMessages: 5,
  passiveMessages: Object.freeze({ c2c: 4, group: 5 }),
  windowMs: Object.freeze({ c2c: 60 * 60000, group: 5 * 60000 }),
});
function messageLimit(type, msgId) {
  return msgId ? REPLY_LIMITS.passiveMessages[type] || REPLY_LIMITS.activeMessages : REPLY_LIMITS.activeMessages;
}
function historyLimit(type, config = CONTEXT_DEFAULTS) {
  return type === 'group' ? config.historyLimitGroup : config.historyLimitC2c;
}
module.exports = { CONTEXT_DEFAULTS, REPLY_LIMITS, messageLimit, historyLimit };
