'use strict';
const { inspectJobs, scheduleRedrive } = require('../job_control');
const HELP = `Usage: npm run jobs -- <list|show|retry>
  list
  show --job <job_id>
  retry --job <job_id> --revision <revision> --request-id <unique-id> --reason <reason> [--ack-duplicate-risk]
Read-only inspection omits message bodies, recipients and credentials.
Stop the bridge before retry, inspect again, then restart after scheduling.
Retry only schedules delivery, never sends HTTP itself. Use --json for compact output.`;
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  const command = args.shift(), options = {};
  const allowed = { list: ['json'], show: ['job', 'json'], retry: ['job', 'revision', 'request-id', 'reason', 'ack-duplicate-risk', 'json'] };
  if (!allowed[command]) throw new Error('arguments');
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed[command].includes(key) || options[key] !== undefined) throw new Error('arguments');
    if (['json', 'ack-duplicate-risk'].includes(key)) options[key] = true;
    else if (args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw new Error('arguments');
  }
  if (command !== 'list' && !options.job) throw new Error('arguments');
  const result = command === 'retry' ? await scheduleRedrive({ id: options.job, revision: options.revision,
    requestId: options['request-id'], reason: options.reason, ackDuplicateRisk: options['ack-duplicate-risk'] === true })
    : { ok: true, [command === 'list' ? 'jobs' : 'job']: inspectJobs({ id: options.job }) };
  console.log(JSON.stringify(result, null, options.json ? 0 : 2));
}
main().catch(error => {
  const known = ['EJOBARGS', 'EJOBNOTFOUND', 'EJOBREPLAY', 'EJOBSTALE', 'EJOBINELIGIBLE', 'EJOBDUPLICATERISK', 'EJOBRETRYLIMIT'];
  const code = error.code === 'EINSTANCELOCKED' ? error.code : known.includes(error.code) ? error.code : 'EJOBCLI';
  const message = code === 'EINSTANCELOCKED' ? 'queue is in use; stop the bridge before scheduling a retry'
    : known.includes(code) ? error.message : 'job command failed; check arguments, state files and permissions (--help)';
  console.error(JSON.stringify({ ok: false, code, error: message })); process.exitCode = 1;
});
