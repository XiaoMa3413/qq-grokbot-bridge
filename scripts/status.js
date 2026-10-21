'use strict';
const { loadConfig } = require('../lib');
async function main() {
  const cfg = loadConfig();
  const response = await fetch(`http://127.0.0.1:${cfg.replyPort}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
}
main().catch(() => { console.error('Bridge health endpoint is unavailable'); process.exitCode = 1; });
