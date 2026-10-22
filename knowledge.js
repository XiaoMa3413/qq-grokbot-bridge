'use strict';
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { atomicWrite, digest } = require('./jobs');
const { acquireInstanceLock } = require('./instance_lock');

const LIMITS = Object.freeze({ inputBytes: 65536, stateBytes: 262144, planBytes: 524288,
  facts: 100, tombstones: 500, factChars: 2000, profileChars: 4000, totalChars: 20000 });
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
function error(code, message) { return Object.assign(new Error(message), { code }); }
function need(ok, field, code = 'EKNOWLEDGEINPUT') {
  if (!ok) throw error(code, 'invalid knowledge field: ' + field);
}
function keys(value, allowed, field) {
  need(object(value) && Object.keys(value).every(k => allowed.includes(k)), field);
}
function scopeOf(type, id) {
  need(['c2c', 'group'].includes(type) && typeof id === 'string' && id.length > 0 && id.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(id), 'scope');
  return { type, id };
}
const keyOf = scope => digest(JSON.stringify([scope.type, scope.id]));
function sourceOf(value) {
  keys(value, ['id', 'label', 'version'], 'source');
  need(identifier(value.id), 'source.id');
  need(typeof value.version === 'string' && value.version.trim().length > 0 && value.version.length <= 128, 'source.version');
  const label = value.label === undefined ? value.id : value.label;
  need(typeof label === 'string' && label.trim().length > 0 && label.length <= 200, 'source.label');
  return { id: value.id, label, version: value.version };
}
function content(value, max, field) {
  need(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'), field);
  return value;
}
function idList(value, field) {
  need(Array.isArray(value) && value.length <= LIMITS.facts && value.every(identifier) && new Set(value).size === value.length, field);
  return [...value];
}
function normalizeImport(input) {
  keys(input, ['schema', 'source', 'profile', 'facts', 'delete', 'restore', 'restore_profile'], 'import');
  need(input.schema === 1, 'schema');
  const result = { schema: 1, source: sourceOf(input.source), facts: [], delete: [], restore: [], restore_profile: false };
  if (input.profile !== undefined) result.profile = input.profile === null ? null : content(input.profile, LIMITS.profileChars, 'profile');
  if (input.facts !== undefined) {
    need(Array.isArray(input.facts) && input.facts.length <= LIMITS.facts, 'facts');
    result.facts = input.facts.map(f => {
      keys(f, ['id', 'content'], 'fact'); need(identifier(f.id), 'fact.id');
      return { id: f.id, content: content(f.content, LIMITS.factChars, 'fact.content') };
    });
    need(new Set(result.facts.map(f => f.id)).size === result.facts.length, 'facts.duplicate');
  }
  for (const field of ['delete', 'restore']) if (input[field] !== undefined) result[field] = idList(input[field], field);
  if (input.restore_profile !== undefined) {
    need(typeof input.restore_profile === 'boolean', 'restore_profile'); result.restore_profile = input.restore_profile;
  }
  const ids = new Set(result.facts.map(f => f.id));
  need(result.delete.every(id => !ids.has(id)) && result.restore.every(id => ids.has(id)), 'overlapping operations');
  need(!result.restore_profile || typeof result.profile === 'string', 'restore_profile');
  return result;
}
function emptyState(scope) {
  return { schema: 1, scope, revision: 0, profile: null, profileDeleted: null, facts: [], tombstones: [], lastCommit: null };
}
function validateState(state, scope) {
  try {
    need(object(state) && state.schema === 1 && isDeepStrictEqual(state.scope, scope), 'state.scope');
    need(Number.isSafeInteger(state.revision) && state.revision >= 0, 'state.revision');
    need(Array.isArray(state.facts) && state.facts.length <= LIMITS.facts, 'state.facts');
    need(Array.isArray(state.tombstones) && state.tombstones.length <= LIMITS.tombstones, 'state.tombstones');
    function record(r, max) {
      need(object(r) && hash(r.version) && r.version === digest(content(r.content, max, 'record.content'))
        && hash(r.batch) && timestamp(r.updatedAt), 'record');
      sourceOf(r.source);
    }
    if (state.profile !== null) record(state.profile, LIMITS.profileChars);
    for (const f of state.facts) { need(identifier(f.id), 'fact.id'); record(f, LIMITS.factChars); }
    function tombstone(t) {
      need(object(t) && hash(t.batch) && timestamp(t.deletedAt) && !('content' in t), 'tombstone'); sourceOf(t.source);
    }
    if (state.profileDeleted !== null) { tombstone(state.profileDeleted); need(state.profile === null, 'profileDeleted'); }
    for (const t of state.tombstones) { need(identifier(t.id), 'tombstone.id'); tombstone(t); }
    const ids = state.facts.concat(state.tombstones).map(f => f.id);
    need(new Set(ids).size === ids.length, 'state.duplicate');
    const total = (state.profile?.content.length || 0) + state.facts.reduce((sum, f) => sum + f.content.length, 0);
    need(total <= LIMITS.totalChars, 'state.totalChars');
    if (state.lastCommit !== null) {
      need(hash(state.lastCommit.id) && timestamp(state.lastCommit.at), 'lastCommit'); sourceOf(state.lastCommit.source);
    }
    return state;
  } catch { throw error('EKNOWLEDGESTATE', 'knowledge state is invalid; preserve the file and check a backup'); }
}
function readJson(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    need(stat.isFile() && stat.size <= maxBytes, 'file size', 'EKNOWLEDGESIZE');
    const raw = fs.readFileSync(fd, 'utf8').replace(/^\uFEFF/, '');
    need(Buffer.byteLength(raw) <= maxBytes, 'file size', 'EKNOWLEDGESIZE');
    try { return JSON.parse(raw); } catch { throw error('EKNOWLEDGEINPUT', 'invalid knowledge JSON'); }
  } finally { fs.closeSync(fd); }
}
function planId(plan) {
  return digest(JSON.stringify({ schema: plan.schema, scope: plan.scope, base_revision: plan.base_revision,
    base_etag: plan.base_etag, input: plan.input, changes: plan.changes }));
}
function changesFor(state, input) {
  const changes = [], existing = new Map(state.facts.map(f => [f.id, f]));
  const deleted = new Set(state.tombstones.map(t => t.id));
  function upsert(kind, id, text, before, blocked, restore) {
    let action = 'add', reason;
    const after = { content: text, source: input.source };
    if (blocked && !restore) { action = 'skip'; reason = 'deleted; explicit restore required'; }
    else if (blocked) action = 'restore';
    else if (before) {
      if (before.content === text && isDeepStrictEqual(before.source, input.source)) { action = 'skip'; reason = 'unchanged'; }
      else action = before.content === text && before.source.id === input.source.id ? 'update' : 'conflict';
    }
    changes.push({ kind, ...(id ? { id } : {}), action, ...(reason ? { reason } : {}), before: before || null, after });
  }
  if (input.profile === null) changes.push({ kind: 'profile', action: state.profile || !state.profileDeleted ? 'delete' : 'skip', before: state.profile, after: null });
  else if (input.profile !== undefined) upsert('profile', null, input.profile, state.profile, !!state.profileDeleted, input.restore_profile);
  for (const f of input.facts) upsert('fact', f.id, f.content, existing.get(f.id), deleted.has(f.id), input.restore.includes(f.id));
  for (const id of input.delete) changes.push({ kind: 'fact', id, action: deleted.has(id) ? 'skip' : 'delete', before: existing.get(id) || null, after: null });
  return changes;
}
function applyChanges(state, plan, at) {
  const next = structuredClone(state), facts = new Map(next.facts.map(f => [f.id, f]));
  const tombstones = new Map(next.tombstones.map(t => [t.id, t]));
  for (const c of plan.changes) {
    if (c.action === 'skip') continue;
    if (c.action === 'delete') {
      const mark = { source: c.before?.source || plan.input.source, batch: plan.id, deletedAt: at };
      if (c.kind === 'profile') { next.profile = null; next.profileDeleted = mark; }
      else { facts.delete(c.id); tombstones.set(c.id, { id: c.id, ...mark }); }
    } else {
      const record = { ...c.after, version: digest(c.after.content), batch: plan.id, updatedAt: at };
      if (c.kind === 'profile') { next.profile = record; next.profileDeleted = null; }
      else { facts.set(c.id, { id: c.id, ...record }); tombstones.delete(c.id); }
    }
  }
  next.facts = [...facts.values()]; next.tombstones = [...tombstones.values()];
  const total = (next.profile?.content.length || 0) + next.facts.reduce((sum, f) => sum + f.content.length, 0);
  need(next.facts.length <= LIMITS.facts && next.tombstones.length <= LIMITS.tombstones && total <= LIMITS.totalChars,
    'knowledge capacity', 'EKNOWLEDGESIZE');
  if (plan.changes.some(c => c.action !== 'skip')) {
    next.revision++; next.lastCommit = { id: plan.id, source: plan.input.source, at };
  }
  validateState(next, plan.scope);
  need(Buffer.byteLength(JSON.stringify(next)) <= LIMITS.stateBytes, 'state size', 'EKNOWLEDGESIZE');
  return next;
}
class KnowledgeStore {
  constructor({ dir = process.env.QQ_KNOWLEDGE_DIR || path.join(__dirname, 'data', 'knowledge'), now = Date.now } = {}) {
    this.dir = path.resolve(dir); this.now = now;
  }
  file(scope) { return path.join(this.dir, keyOf(scope) + '.json'); }
  read(type, id) {
    const scope = scopeOf(type, id);
    let state;
    try { state = readJson(this.file(scope), LIMITS.stateBytes); }
    catch (e) { if (e.code !== 'ENOENT') throw error('EKNOWLEDGESTATE', 'cannot read valid knowledge state; preserve the file and check a backup'); }
    state = validateState(state === undefined ? emptyState(scope) : state, scope);
    return { state, etag: '"' + digest(JSON.stringify(state)) + '"' };
  }
  snapshot(type, id) {
    const { state, etag } = this.read(type, id);
    return { schema: 1, source: 'bridge_selected_import', platform_sync: 'not_configured', read_only: true,
      scope: state.scope, revision: state.revision, etag, profile: state.profile, facts: state.facts };
  }
  preview(type, id, value) {
    const { state, etag } = this.read(type, id), input = normalizeImport(value);
    const plan = { schema: 1, scope: state.scope, base_revision: state.revision, base_etag: etag, input, changes: changesFor(state, input) };
    plan.id = planId(plan);
    // Capacity errors belong in the preview, before any operator approves a commit.
    applyChanges(state, plan, new Date(this.now()).toISOString());
    return plan;
  }
  async commit(type, id, plan, { replaceConflicts = false } = {}) {
    const scope = scopeOf(type, id);
    need(object(plan) && plan.schema === 1 && isDeepStrictEqual(scope, plan.scope) && hash(plan.id), 'plan scope', 'EKNOWLEDGEPLAN');
    need(plan.id === planId(plan), 'plan digest', 'EKNOWLEDGEPLAN');
    let lock;
    try { lock = await acquireInstanceLock(this.dir); }
    catch (e) { if (e.code === 'EINSTANCELOCKED') throw error('EKNOWLEDGEBUSY', 'another knowledge commit is active; retry'); throw e; }
    try {
      const { state, etag } = this.read(type, id);
      if (state.lastCommit?.id === plan.id) return { ok: true, revision: state.revision, replayed: true };
      need(plan.base_revision === state.revision && plan.base_etag === etag, 'preview is stale; preview again', 'EKNOWLEDGESTALE');
      const expected = this.preview(type, id, plan.input);
      need(isDeepStrictEqual(expected, plan), 'plan changed; preview again', 'EKNOWLEDGEPLAN');
      need(replaceConflicts || !plan.changes.some(c => c.action === 'conflict'), 'conflicts require --replace-conflicts', 'EKNOWLEDGECONFLICT');
      const next = applyChanges(state, plan, new Date(this.now()).toISOString());
      if (next.revision !== state.revision) atomicWrite(this.file(scope), next);
      return { ok: true, revision: next.revision, changed: next.revision !== state.revision };
    } finally { await new Promise(resolve => lock.close(resolve)); }
  }
  check() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
    let count = 0;
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      try {
        const value = readJson(path.join(this.dir, name), LIMITS.stateBytes);
        const scope = scopeOf(value?.scope?.type, value?.scope?.id);
        need(name === keyOf(scope) + '.json', 'state filename', 'EKNOWLEDGESTATE');
        validateState(value, scope); count++;
      } catch { throw error('EKNOWLEDGESTATE', 'invalid knowledge state file: ' + name); }
    }
    return count;
  }
}
module.exports = { KnowledgeStore, LIMITS, normalizeImport, readJson };
