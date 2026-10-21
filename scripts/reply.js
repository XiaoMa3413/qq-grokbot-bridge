'use strict';
// Reads one reply JSON object from stdin. Works on Windows, Linux and the Grok computer.
const fs = require('fs');
const { loadReplyToken } = require('../lib');

async function main() {
  const url = new URL(process.env.QQ_REPLY_URL || `http://127.0.0.1:${process.env.QQ_REPLY_PORT || 8787}/reply`);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/reply')
    throw new Error('QQ_REPLY_URL must use HTTPS (HTTP is allowed only on loopback) and end in /reply');
  if (!loopback && !process.env.QQ_REPLY_TOKEN)
    throw new Error('set QQ_REPLY_TOKEN for remote replies');
  const input = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  const reply = JSON.parse(input);
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('stdin must be a JSON object');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'X-Reply-Token': loadReplyToken() },
    body: JSON.stringify(reply),
  });
  const text = await response.text();
  process.stdout.write(text + '\n');
  let result;
  try { result = JSON.parse(text); } catch { /* A proxy error page is a failure. */ }
  if (!response.ok || result?.ok !== true) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
