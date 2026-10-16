'use strict';
// Pure decision logic for the WebSocket liveness check used by bridge.js.
// `wsState` is the readyState number of the live socket (1 = OPEN, as on the 'ws' WebSocket),
// `lastAliveAt` the wall-clock time of the last READY/RESUMED or heartbeat ACK, `now` the
// current wall-clock time, and `maxAgeMs` how long silence is tolerated.
function checkLiveness({ wsState, lastAliveAt, now, maxAgeMs }) {
  const ageMs = now - lastAliveAt;
  if (ageMs > maxAgeMs) return { ok: false, reason: 'stale', ageMs };
  if (wsState !== 1) return { ok: false, reason: 'ws-not-open', ageMs };
  return { ok: true, reason: '', ageMs };
}
// Detect a suspended or fast-forwarded clock: if (now - prevTick) - intervalMs exceeds the
// threshold, the local clock disagrees with the heartbeat interval by more than tolerated.
function detectClockJump(prevTick, now, intervalMs, thresholdMs = 30000) {
  return (now - prevTick) - intervalMs > thresholdMs;
}
module.exports = { checkLiveness, detectClockJump };
