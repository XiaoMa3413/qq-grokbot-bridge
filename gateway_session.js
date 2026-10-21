'use strict';
const fs = require('node:fs'), path = require('node:path');
const { atomicWrite, digest } = require('./jobs');

class GatewaySession {
  constructor(directory, appId) {
    this.file = path.join(directory, 'gateway-session.json');
    this.app = digest(String(appId));
    this.sessionId = null; this.seq = null;
    if (!fs.existsSync(this.file)) return;
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const empty = saved.session_id === null && saved.seq === null;
    if (saved.schema !== 1 || saved.app !== this.app || (!empty &&
        (typeof saved.session_id !== 'string' || !saved.session_id || !Number.isSafeInteger(saved.seq) || saved.seq < 0)))
      throw new Error('invalid gateway checkpoint or QQ app does not match this queue directory');
    this.sessionId = saved.session_id; this.seq = saved.seq;
  }
  commit(sessionId, seq) {
    atomicWrite(this.file, { schema: 1, app: this.app, session_id: sessionId, seq });
    this.sessionId = sessionId; this.seq = seq;
  }
}
module.exports = { GatewaySession };
