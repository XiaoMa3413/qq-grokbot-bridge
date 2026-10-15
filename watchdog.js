'use strict';
// A one-shot timer that fires onFire(reason) after arm(ms, reason). A later arm()
// before it fires replaces the prior timer (exactly one timer is ever pending);
// disarm() cancels it so onFire never runs. The timer functions are injectable so
// tests can use fake timers (setTimer/clearTimer default to the real globals).
class Watchdog {
  constructor({ onFire, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.onFire = onFire;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.reason = null;
  }
  // Arm (or re-arm) the timer for `ms`, remembering `reason`; any pending timer is cleared first.
  arm(ms, reason) {
    this.disarm();
    this.reason = reason;
    this.timer = this.setTimer(() => this._fire(), ms);
  }
  // Cancel a pending timer so onFire never runs.
  disarm() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.reason = null;
  }
  _fire() {
    this.timer = null;
    const reason = this.reason;
    this.reason = null;
    if (typeof this.onFire === 'function') this.onFire(reason);
  }
}
module.exports = { Watchdog };
