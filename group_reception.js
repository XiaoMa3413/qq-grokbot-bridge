'use strict';
const { stableId } = require('./identity');
const { toPayload } = require('./lib');

const MODES = new Set(['all', 'only_mention', 'mention_and_context']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const memberId = user => stableId(user?.member_openid) || stableId(user?.id);

// This cache queries QQ, never the model. Do not infer self identity from names,
// bot:true, app IDs or user-authored mention-looking text.
class GroupReception {
  constructor(api, { now = Date.now, wait = sleep, ttlMs = 300000, retryMs = 60000,
    minIntervalMs = 2100, maxGroups = 512, log = () => {} } = {}) {
    Object.assign(this, { api, now, wait, ttlMs, retryMs, minIntervalMs, maxGroups, log });
    this.cache = new Map(); this.pending = new Map(); this.tail = Promise.resolve(); this.nextQueryAt = 0;
  }
  invalidate(group) { this.cache.delete(group); }
  cached(group, fullEvent) {
    const entry = this.cache.get(group);
    if (!entry || entry.expiresAt <= this.now() || fullEvent && !entry.observedFull) return null;
    this.cache.delete(group); this.cache.set(group, entry); return entry;
  }
  async get(group, { fullEvent = false } = {}) {
    const cached = this.cached(group, fullEvent);
    if (cached) return cached;
    if (this.pending.has(group)) return this.pending.get(group);
    const request = this.tail.then(async () => {
      const delay = Math.max(0, this.nextQueryAt - this.now());
      if (delay) await this.wait(delay);
      this.nextQueryAt = this.now() + this.minIntervalMs;
      let entry;
      try {
        const state = await this.api.req('GET', `/v2/groups/${encodeURIComponent(group)}/bot_state`);
        if (state?.code === 11253) throw Object.assign(new Error('permission denied'), { body: { code: 11253 } });
        const self = stableId(state?.member_openid);
        if (!self || !MODES.has(state?.recv_msg_setting)) throw new Error('invalid state');
        entry = { mode: state.recv_msg_setting, self, status: 'ok', queriedAt: this.now(), expiresAt: this.now() + this.ttlMs };
      } catch (error) {
        const status = error.body?.code === 11253 || error.status === 403 ? 'permission_denied' : 'unavailable';
        entry = { mode: null, self: null, status, queriedAt: this.now(), expiresAt: this.now() + this.retryMs };
        this.log('group state', status); // No IDs, URLs, raw errors or response bodies.
      }
      entry.observedFull = fullEvent;
      this.cache.delete(group); this.cache.set(group, entry);
      while (this.cache.size > this.maxGroups) this.cache.delete(this.cache.keys().next().value);
      return entry;
    });
    this.tail = request.catch(() => {});
    this.pending.set(group, request);
    try { return await request; } finally { this.pending.delete(group); }
  }
  payload(type, data) {
    if (['GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MSG_RECEIVE', 'GROUP_MSG_REJECT'].includes(type)) {
      this.invalidate(data?.group_openid); return null;
    }
    const payload = toPayload(type, data);
    if (payload?.type !== 'group') return payload;
    if (!stableId(payload.group_openid)) throw new Error('invalid group route');
    const fullEvent = type === 'GROUP_MESSAGE_CREATE', cached = this.cached(payload.group_openid, fullEvent);
    return cached ? this.annotate(payload, type, data, cached)
      : this.get(payload.group_openid, { fullEvent }).then(state => this.annotate(payload, type, data, state));
  }
  summary() {
    const settings = { all: 0, only_mention: 0, mention_and_context: 0, unavailable: 0 };
    for (const entry of this.cache.values()) settings[entry.expiresAt > this.now() && entry.status === 'ok' ? entry.mode : 'unavailable']++;
    return { cached_groups: this.cache.size, querying_groups: this.pending.size, settings };
  }
  annotate(payload, type, data, state) {
    const selfMessage = !!state.self && memberId(data.author) === state.self;
    const selfMention = !!state.self && payload.mentions.some(user => memberId(user) === state.self);
    payload.at = !selfMessage && (type === 'GROUP_AT_MESSAGE_CREATE' || selfMention);
    payload.group_receive = { setting: state.mode, status: state.status,
      source: state.status === 'ok' ? 'qq_bot_state' : 'unavailable',
      queried_at: new Date(state.queriedAt).toISOString(), observed_event: type,
      self_identity_known: !!state.self,
      trigger: selfMessage ? 'self_message' : type === 'GROUP_AT_MESSAGE_CREATE' ? 'dedicated_at'
        : selfMention ? 'self_mention' : !state.self ? 'self_identity_unavailable' : 'not_mentioned' };
    return payload;
  }
}
module.exports = { GroupReception };
