'use strict';
const fs = require('node:fs');
const { KnowledgeStore, LIMITS, readJson } = require('../knowledge');
const HELP = `Usage: npm run knowledge -- <preview|commit|show> --type <c2c|group> --id <QQ-openid>
  preview --file <selected.json> --out <plan.json>  Preview without changing stored knowledge
  commit --plan <plan.json> [--replace-conflicts]   Apply exactly the reviewed plan
  show                                            Show state, sources and deletion markers
Use --json for compact output. Preview files contain selected data; keep them private.`;
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(HELP); return; }
  const command = args.shift(), options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--json', '--replace-conflicts'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--type', '--id', '--file', '--out', '--plan'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      if (options[arg.slice(2)] !== undefined) throw new Error('duplicate option');
      options[arg.slice(2)] = args[++i];
    } else throw new Error('invalid arguments; use --help');
  }
  const allowed = { preview: ['type', 'id', 'file', 'out', 'json'], commit: ['type', 'id', 'plan', 'replace-conflicts', 'json'], show: ['type', 'id', 'json'] };
  if (!allowed[command] || Object.keys(options).some(k => !allowed[command].includes(k))) throw new Error('invalid arguments; use --help');
  const store = new KnowledgeStore();
  let result;
  if (command === 'preview') {
    if (!options.file || !options.out) throw new Error('preview needs --file and --out');
    result = store.preview(options.type, options.id, readJson(options.file, LIMITS.inputBytes));
    // Never overwrite an import, a previous preview, or a live state file.
    fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } else if (command === 'commit') {
    if (!options.plan) throw new Error('commit needs --plan');
    result = await store.commit(options.type, options.id, readJson(options.plan, LIMITS.planBytes), { replaceConflicts: options['replace-conflicts'] === true });
  } else result = store.read(options.type, options.id);
  console.log(JSON.stringify(result, null, options.json ? 0 : 2));
}
main().catch(e => {
  // Filesystem/JSON errors can contain source fragments; report only known messages.
  const message = e.code?.startsWith('EKNOWLEDGE') ? e.message : 'knowledge command failed; check arguments, files and permissions (--help)';
  console.error(JSON.stringify({ ok: false, code: e.code?.startsWith('EKNOWLEDGE') ? e.code : 'EKNOWLEDGECLI', error: message }));
  process.exitCode = 1;
});
