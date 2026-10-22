'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { REPLY_LIMITS, messageLimit } = require('./policy');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const targetOf = p => p.type === 'group' ? p.group_openid : p.openid;
const idOf = p => digest(JSON.stringify([p.type, targetOf(p), p.msg_id]));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const time = v => count(v) && v <= 8640000000000000;
function invalidJob(file, field) {
  return Object.assign(new Error(`invalid persisted job: ${file} (${field})`), { code: 'EJOBSTATE', file, field });
}
function validateJob(job, file) {
  const need = (ok, field) => { if (!ok) throw invalidJob(file, field); };
  need(object(job), 'record');
  need(job.schema === 1, 'schema');
  need(object(job.payload), 'payload');
  const p = job.payload;
  need(['c2c', 'group'].includes(p.type) && typeof targetOf(p) === 'string' && !!targetOf(p)
    && typeof p.msg_id === 'string' && !!p.msg_id, 'payload.route');
  need(typeof job.id === 'string' && /^[a-f0-9]{64}$/.test(job.id) && job.id + '.json' === file && idOf(p) === job.id, 'id');
  need(Number.isSafeInteger(job.order) && job.order > 0, 'order');
  for (const key of ['createdAt', 'deadline', 'nextAttemptAt']) need(time(job[key]), key);
  need(count(job.attempts), 'attempts');
  if (job.acceptedAt !== undefined) need(time(job.acceptedAt), 'acceptedAt');
  need(['pending', 'dispatching', 'accepted', 'failed', 'expired'].includes(job.delivery), 'delivery');
  need(typeof job.prepared === 'boolean', 'prepared');
  need(object(job.assets) && Object.entries(job.assets).every(([key, value]) => /^[a-f0-9]{64}$/.test(key)
    && typeof value === 'string' && !!value), 'assets');
  if (job.lastError !== undefined) need(typeof job.lastError === 'string', 'lastError');
  if (job.sentCount !== undefined) need(count(job.sentCount) && job.sentCount <= messageLimit(p.type, p.msg_id), 'sentCount');

  // Schema 1 before segmented replies stored only `reply`; normalize it in memory.
  // Missing legacy seq/final mean the first and final reply, never a new send.
  const legacy = job.replies === undefined;
  const records = legacy ? (job.reply == null ? [] : [job.reply]) : job.replies;
  need(Array.isArray(records) && records.length <= REPLY_LIMITS.segments, 'replies');
  function replyRecord(reply, index) {
    const prefix = `replies[${index}]`;
    need(object(reply), prefix);
    const seq = legacy && reply.seq === undefined ? 1 : reply.seq;
    const final = legacy && reply.final === undefined ? true : reply.final;
    need(seq === index + 1, prefix + '.seq');
    need(typeof final === 'boolean', prefix + '.final');
    need(['sending', 'uncertain', 'done'].includes(reply.state), prefix + '.state');
    need(typeof reply.fingerprint === 'string' && !!reply.fingerprint, prefix + '.fingerprint');
    for (const key of ['startedAt', 'completedAt']) if (reply[key] !== undefined) need(time(reply[key]), prefix + '.' + key);
    if (reply.state === 'done') {
      need(Number.isInteger(reply.httpStatus) && reply.httpStatus >= 200 && reply.httpStatus <= 599, prefix + '.httpStatus');
      need(object(reply.body) && typeof reply.body.ok === 'boolean', prefix + '.body');
    }
    if (index < records.length - 1) need(reply.state === 'done' && final === false && reply.body.ok, prefix + '.closed');
    return { ...reply, seq, final };
  }
  const replies = records.map(replyRecord), reply = replies.at(-1) || null;
  if (!legacy) {
    need(reply === null ? job.reply === null : object(job.reply), 'reply');
    if (reply) need(isDeepStrictEqual(replyRecord(job.reply, replies.length - 1), reply), 'reply.mirror');
  }
  return { ...job, replies, reply };
}
// Read-only validation completes for the whole queue before recovery/pruning can write.
// Unknown fields are retained; unknown schema versions and malformed records fail closed.
function readJobs(dir) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const orders = new Set();
  return names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort().map(file => {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    let value;
    try { value = JSON.parse(raw); } catch { throw invalidJob(file, 'json'); }
    const job = validateJob(value, file);
    if (orders.has(job.order)) throw invalidJob(file, 'order.duplicate');
    orders.add(job.order);
    return job;
  });
}
module.exports = { digest, targetOf, idOf, validateJob, readJobs };
