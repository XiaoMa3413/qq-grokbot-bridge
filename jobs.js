'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const targetOf = p => p.type === 'group' ? p.group_openid : p.openid;
const idOf = p => digest(JSON.stringify([p.type, targetOf(p), p.msg_id]));
const repliesOf = job => job.replies || (job.reply ? [job.reply] : []);
const replyClosed = job => job.reply?.state === 'done' && (job.reply.final !== false || !job.reply.body?.ok);
function atomicFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, contents); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    if (process.platform === 'linux') {
      const parent = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function atomicWrite(file, value) { atomicFile(file, JSON.stringify(value)); }
class JobStore {
  constructor({ dir = process.env.QQ_JOBS_DIR || path.join(__dirname, 'data', 'jobs'), now = Date.now,
    retentionMs = 7 * 86400000, maxJobs = 10000 } = {}) {
    this.dir = dir; this.now = now; this.retentionMs = retentionMs; this.maxJobs = maxJobs; this.jobs = new Map(); this.order = 0;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const job = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (job.id + '.json' !== name || idOf(job.payload) !== job.id || job.schema !== 1 || !Number.isSafeInteger(job.order))
        throw new Error('invalid persisted job: ' + name);
      this.order = Math.max(this.order, job.order);
      if (job.replies?.length) job.reply = job.replies.at(-1);
      this.jobs.set(job.id, job);
      if (job.delivery === 'dispatching') { job.delivery = 'pending'; job.nextAttemptAt = now(); this.save(job); }
      if (job.reply?.state === 'sending') { job.reply.state = 'uncertain'; this.save(job); }
    }
    this.prune();
  }
  save(job) { atomicWrite(path.join(this.dir, job.id + '.json'), job); }
  prune() {
    for (const [id, job] of this.jobs) if (job.deadline + this.retentionMs < this.now()) {
      fs.unlinkSync(path.join(this.dir, id + '.json')); this.jobs.delete(id);
    }
  }
  enqueue(payload) {
    if (!['c2c', 'group'].includes(payload.type) || typeof targetOf(payload) !== 'string' || !targetOf(payload) ||
      typeof payload.msg_id !== 'string' || !payload.msg_id) throw new Error('invalid message route');
    const id = idOf(payload);
    if (this.jobs.has(id)) return { job: this.jobs.get(id), added: false };
    this.prune();
    if (this.jobs.size >= this.maxJobs) throw new Error('job capacity exceeded');
    const now = this.now(), parsed = Date.parse(payload.timestamp);
    const receivedAt = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
    const job = { schema: 1, id, order: ++this.order, payload: structuredClone(payload), createdAt: now,
      deadline: receivedAt + (payload.type === 'group' ? 5 * 60000 : 60 * 60000),
      delivery: 'pending', attempts: 0, nextAttemptAt: now, prepared: false, assets: {}, reply: null };
    this.save(job); this.jobs.set(id, job);
    return { job, added: true };
  }
  get(id) { return this.jobs.get(id); }
  findReply(body) {
    const job = this.get(idOf(body));
    if (!job || (body.job_id !== undefined && body.job_id !== job.id)) return null;
    return job;
  }
  // Persist the intent before any QQ side effect. An interrupted send is never blindly repeated.
  beginReply(job, fingerprint, { seq = 1, final = true } = {}) {
    if (!Number.isInteger(seq) || seq < 1 || seq > 5 || typeof final !== 'boolean')
      return { status: 400, body: { ok: false, error: 'invalid reply sequence or final flag' } };
    const records = repliesOf(job), existing = records[seq - 1];
    if (existing) {
      if (existing.fingerprint !== fingerprint || (existing.final !== false) !== final)
        return { status: 409, body: { ok: false, error: 'reply_seq already has a different reply' } };
      if (existing.state === 'done') return { status: existing.httpStatus, body: { ...existing.body, replayed: true } };
      return { status: 409, body: { ok: false, error: existing.state === 'uncertain' ? 'reply outcome unknown after restart; do not resend' : 'reply already in progress' } };
    }
    if (job.reply?.state === 'uncertain' || job.reply?.state === 'sending')
      return { status: 409, body: { ok: false, error: 'previous reply is sending or uncertain; do not send another segment' } };
    if (replyClosed(job)) return { status: 409, body: { ok: false, error: 'job reply is already closed' } };
    if (seq !== records.length + 1) return { status: 409, body: { ok: false, error: 'reply_seq must be consecutive', next_reply_seq: records.length + 1 } };
    if (this.now() >= job.deadline) return { status: 410, body: { ok: false, error: 'QQ reply window expired' } };
    const reply = { state: 'sending', fingerprint, startedAt: this.now(), seq, final };
    // Publish in-memory state only after the intent is durable.
    const next = { ...job, replies: [...records, reply], reply };
    this.save(next); Object.assign(job, next);
    return null;
  }
  finishReply(job, httpStatus, body) {
    const reply = { ...job.reply, state: 'done', completedAt: this.now(), httpStatus, body };
    const next = { ...job, replies: [...repliesOf(job).slice(0, -1), reply], reply };
    this.save(next); Object.assign(job, next);
  }
  summary() {
    const summary = { pending: 0, awaiting_reply: 0, replying: 0, completed: 0, failed: 0, expired: 0, uncertain: 0 };
    for (const job of this.jobs.values()) {
      if (job.reply?.state === 'uncertain') summary.uncertain++;
      else if (job.reply?.state === 'sending') summary.replying++;
      else if (replyClosed(job)) summary[job.reply.body.ok ? 'completed' : 'failed']++;
      else if (this.now() >= job.deadline || job.delivery === 'expired') summary.expired++;
      else if (job.delivery === 'failed') summary.failed++;
      else if (job.delivery === 'accepted' || job.reply) summary.awaiting_reply++;
      else summary.pending++;
    }
    return summary;
  }
}

class ForwardWorker {
  constructor(store, { prepare = async p => p, send, log = () => {}, concurrency = 4 } = {}) {
    this.store = store; this.prepare = prepare; this.send = send; this.log = log; this.concurrency = concurrency; this.running = null;
  }
  runOnce() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    const blocked = new Set(), eligible = [];
    for (const job of [...this.store.jobs.values()].sort((a, b) => a.order - b.order)) {
      if (replyClosed(job) || job.delivery === 'failed' || job.delivery === 'expired') continue;
      if (this.store.now() >= job.deadline) { job.delivery = 'expired'; this.store.save(job); this.log('job expired', job.id); continue; }
      const conversation = JSON.stringify([job.payload.type, targetOf(job.payload)]);
      if (blocked.has(conversation)) continue;
      blocked.add(conversation);
      if (!job.reply && job.delivery === 'pending' && job.nextAttemptAt <= this.store.now()) eligible.push(job);
    }
    for (let i = 0; i < eligible.length; i += this.concurrency)
      await Promise.all(eligible.slice(i, i + this.concurrency).map(job => this.dispatch(job)));
  }
  async dispatch(job) {
    job.delivery = 'dispatching'; job.attempts++; this.store.save(job);
    try {
      if (!job.prepared) {
        const prepared = await this.prepare(structuredClone(job.payload), job);
        job.payload = prepared; job.prepared = true; this.store.save(job);
      }
      if (this.store.now() >= job.deadline) { job.delivery = 'expired'; this.store.save(job); return; }
      const response = await this.send(job.payload, job);
      // A fast callback can arrive before the webhook request completes; keep its outcome.
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (response.ok) { job.delivery = 'accepted'; job.acceptedAt = this.store.now(); this.log('forwarded', job.id); }
      else if (retryable) {
        job.delivery = 'pending'; job.nextAttemptAt = this.retryAt(job, response.retryAfterMs);
        job.lastError = 'HTTP ' + response.status; this.log('forward retry', job.id, job.lastError);
      } else { job.delivery = 'failed'; job.lastError = 'HTTP ' + response.status; this.log('forward failed', job.id, job.lastError); }
    } catch {
      job.delivery = 'pending'; job.nextAttemptAt = this.retryAt(job);
      job.lastError = 'transport or preparation failed'; this.log('forward retry', job.id, job.lastError);
    }
    this.store.save(job);
  }
  retryAt(job, retryAfterMs = 0) {
    return this.store.now() + Math.max(Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 10)), Math.max(0, retryAfterMs || 0));
  }
}
module.exports = { JobStore, ForwardWorker, atomicWrite, atomicFile, digest, idOf, targetOf, repliesOf, replyClosed };
