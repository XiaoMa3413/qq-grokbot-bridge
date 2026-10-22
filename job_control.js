'use strict';
const path = require('node:path');
const { readJobs, validateJob, digest } = require('./job_state');
const { atomicWrite, repliesOf, replyClosed } = require('./jobs');
const { acquireInstanceLock } = require('./instance_lock');
const { interruptedForward, forwardDiagnostic } = require('./forwarding');
const defaultDirectory = () => process.env.QQ_JOBS_DIR || path.join(__dirname, 'data', 'jobs');
function revisionOf(job) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  // Normalize legacy reply records before hashing; key order is not a change.
  return digest(JSON.stringify(stable(validateJob(job, job.id + '.json'))));
}
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function diagnostic(job, now = Date.now()) {
  const effective = job.delivery === 'dispatching' ? interruptedForward(job, now) : job;
  const replied = repliesOf(job).length > 0 || (job.sentCount || 0) > 0;
  const expired = now >= job.deadline || job.delivery === 'expired';
  const count = job.redrives?.length || 0;
  const blocked = expired ? 'expired' : replied ? 'reply_exists' : !['failed', 'uncertain'].includes(effective.delivery)
    ? 'delivery_state' : count >= 20 ? 'retry_limit' : null;
  const eligible = blocked === null;
  return { job_id: job.id, revision: revisionOf(job), delivery: job.delivery,
    effective_delivery: effective.delivery, attempts: job.attempts, deadline: new Date(job.deadline).toISOString(),
    expired, reply: job.reply?.state || null, reply_closed: replyClosed(job), messages_used: job.sentCount || 0,
    forward: forwardDiagnostic(effective.forward),
    redrive: { eligible, blocked_reason: blocked, requires_duplicate_ack: effective.delivery === 'uncertain', count, limit: 20 },
    redrives: (job.redrives || []).map(r => ({ request_id: r.requestId, at: new Date(r.at).toISOString(), previous_delivery: r.previousDelivery })) };
}
function inspectJobs({ dir = defaultDirectory(), id, now = Date.now() } = {}) {
  if (id !== undefined && !/^[a-f0-9]{64}$/.test(id)) throw failure('EJOBARGS', 'invalid job ID');
  const jobs = readJobs(dir).sort((a, b) => a.order - b.order);
  if (id) {
    const job = jobs.find(j => j.id === id);
    if (!job) throw failure('EJOBNOTFOUND', 'job not found');
    return diagnostic(job, now);
  }
  return jobs.map(j => diagnostic(j, now));
}
async function scheduleRedrive({ dir = defaultDirectory(), id, revision, requestId, reason, ackDuplicateRisk = false, now = Date.now } = {}) {
  if (!/^[a-f0-9]{64}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(revision || '') ||
    typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId) ||
    typeof reason !== 'string' || !reason.trim() || reason.length > 200 || /[\r\n\0]/.test(reason) || typeof ackDuplicateRisk !== 'boolean')
    throw failure('EJOBARGS', 'retry requires job ID, current revision, unique request ID and a short single-line reason');
  const lock = await acquireInstanceLock(dir);
  try {
    // Unlike JobStore, reading does not recover/prune unrelated records.
    const job = readJobs(dir).find(j => j.id === id);
    if (!job) throw failure('EJOBNOTFOUND', 'job not found');
    const previous = job.redrives?.find(r => r.requestId === requestId);
    if (previous) {
      if (previous.revision !== revision || previous.reason !== reason || previous.ackDuplicateRisk !== ackDuplicateRisk)
        throw failure('EJOBREPLAY', 'request ID already used with different retry parameters');
      return { ok: true, replayed: true, scheduled: false, job: diagnostic(job, now()) };
    }
    if (revisionOf(job) !== revision) throw failure('EJOBSTALE', 'job changed; inspect it again before retrying');
    const current = diagnostic(job, now());
    if (current.redrive.blocked_reason === 'retry_limit') throw failure('EJOBRETRYLIMIT', 'manual retry limit reached');
    if (!current.redrive.eligible) throw failure('EJOBINELIGIBLE', 'only unexpired failed or uncertain forwards without any reply can be retried');
    if (current.redrive.requires_duplicate_ack && !ackDuplicateRisk)
      throw failure('EJOBDUPLICATERISK', 'inspect remote execution first; retry requires --ack-duplicate-risk');
    const at = now();
    if (at >= job.deadline) throw failure('EJOBINELIGIBLE', 'job expired before retry could be scheduled');
    const next = { ...job, delivery: 'pending', nextAttemptAt: at,
      redrives: [...(job.redrives || []), { requestId, revision, reason, ackDuplicateRisk, at, previousDelivery: job.delivery }] };
    // Keep original route, payload snapshot, deadline, order and attempt count.
    // This schedules one attempt; only the bridge performs network operations.
    atomicWrite(path.join(dir, job.id + '.json'), next);
    return { ok: true, replayed: false, scheduled: true, job: diagnostic(next, at) };
  } finally { await new Promise((resolve, reject) => lock.close(error => error ? reject(error) : resolve())); }
}
module.exports = { inspectJobs, scheduleRedrive, diagnostic, revisionOf };
