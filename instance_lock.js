'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');

// Kernel-owned IPC endpoints disappear on process exit, including SIGKILL.
// Canonicalize aliases before naming the lock; no PID file or stale-lock deletion is needed.
async function acquireInstanceLock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let canonical = fs.realpathSync.native(path.resolve(directory));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const key = crypto.createHash('sha256').update(canonical).digest('hex');
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\qq-grokbot-bridge-' + key
    : process.platform === 'linux' ? '\0qq-grokbot-bridge-' + key : null;
  if (!endpoint) throw new Error('instance locking requires Windows or Linux');
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  await new Promise((resolve, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') {
        const conflict = new Error('queue directory is already in use; stop the other bridge before starting this instance');
        conflict.code = 'EINSTANCELOCKED'; reject(conflict);
      } else reject(error);
    });
    server.listen(endpoint, resolve);
  });
  return server;
}
module.exports = { acquireInstanceLock };
