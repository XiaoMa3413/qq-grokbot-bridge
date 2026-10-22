'use strict';
// Only failures known to happen before a connection exists are safe to retry.
// Timeouts, socket resets and unknown exceptions can follow remote acceptance.
const CONNECT_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const CODES = ['preparing', 'sending', 'preparation_failed', 'not_sent', 'connection_failed', 'http_accepted',
  'http_rate_limited', 'http_rejected', 'http_ambiguous', 'transport_ambiguous', 'interrupted', 'callback_received'];
function transportOutcome(error) {
  const seen = new Set();
  function beforeConnection(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value.errors)) return value.errors.length > 0 && value.errors.every(beforeConnection);
    if (value.cause) return beforeConnection(value.cause);
    return CONNECT_ERRORS.has(value.code);
  }
  if (error?.code === 'EFORWARDNOTSENT') return { outcome: 'retryable', code: 'not_sent' };
  return beforeConnection(error) ? { outcome: 'retryable', code: 'connection_failed' }
    : { outcome: 'uncertain', code: 'transport_ambiguous' };
}
function responseOutcome(response) {
  const status = response?.status;
  if (!Number.isInteger(status) || status < 200 || status > 599)
    return { outcome: 'uncertain', code: 'transport_ambiguous' };
  const httpStatus = status;
  if (status < 300) return { outcome: 'accepted', code: 'http_accepted', httpStatus };
  if (status === 429) return { outcome: 'retryable', code: 'http_rate_limited', httpStatus };
  if (status === 408 || status >= 500) return { outcome: 'uncertain', code: 'http_ambiguous', httpStatus };
  return { outcome: 'failed', code: 'http_rejected', httpStatus };
}
function interruptedForward(job, now) {
  if (job.reply) return { ...job, delivery: 'accepted', forward: { phase: 'settled', outcome: 'accepted',
    code: 'callback_received', startedAt: job.forward?.startedAt ?? now, completedAt: now } };
  const preparing = job.forward?.phase === 'preparing';
  return { ...job, delivery: preparing ? 'pending' : 'uncertain', nextAttemptAt: now,
    forward: { phase: 'settled', outcome: preparing ? 'retryable' : 'uncertain', code: preparing ? 'preparation_failed' : 'interrupted',
      startedAt: job.forward?.startedAt ?? now, completedAt: now } };
}
function forwardDiagnostic(forward) {
  if (!forward) return null;
  return Object.fromEntries(['phase', 'outcome', 'code', 'startedAt', 'completedAt', 'httpStatus']
    .filter(key => forward[key] !== undefined).map(key => [key, forward[key]]));
}
module.exports = { CODES, transportOutcome, responseOutcome, interruptedForward, forwardDiagnostic };
