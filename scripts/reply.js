'use strict';
// Reads one reply JSON object from stdin. Works on Windows, Linux and the Grok computer.
const fs = require('fs');
const { replyConfiguration } = require('./reply-config');

async function main() {
  const { url, token } = replyConfiguration();
  const input = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  const reply = JSON.parse(input);
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('stdin must be a JSON object');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'X-Reply-Token': token },
    body: JSON.stringify(reply),
  });
  const text = await response.text();
  process.stdout.write(text + '\n');
  let result;
  try { result = JSON.parse(text); } catch { /* A proxy error page is a failure. */ }
  if (!response.ok || result?.ok !== true) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
