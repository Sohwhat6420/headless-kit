#!/usr/bin/env node
// A stand-in for a coding-agent CLI, used by the tests and the demo. It never calls any model.
// Each "account" is a directory named by FAKE_CLI_HOME (set through the account's env in the config), the same way a
// real CLI is pointed at one signed-in account by GEMINI_CLI_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR.
// <home>/behaviour.json decides what this account does:
//   { "mode": "write" }       write the requested file (ending in the sentinel) and exit 0
//   { "mode": "nowrite" }     claim success, write nothing, exit 0
//   { "mode": "stub" }        write a tiny file, exit 0
//   { "mode": "nosentinel" }  write a long file that stops before the sentinel, exit 0
//   { "mode": "wall", "resetIn": "2h0m0s", "exitCode": 1 }   print a quota refusal
//   { "mode": "fail" }        print an error, exit 1
//   { "mode": "hang" }        never finish (the timeout must kill it)
//   optional: "delayMs" (sleep first), "exitCode" (override)
// Every call is appended to <home>/calls.jsonl: pid, argv, and whether a scrubbed variable leaked through.
// The requested file is named in the prompt on a line "OUTPUT-PATH: <absolute path>" (the config's promptSuffix).
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.FAKE_CLI_HOME;
// `node --test` picks up every .mjs under test/, this file included. Run that way (no account), it does nothing.
if (!home && process.env.NODE_TEST_CONTEXT) process.exit(0);
if (!home) { process.stderr.write('fake-cli: FAKE_CLI_HOME is not set (no account selected)\n'); process.exit(41); }
let b = { mode: 'write' };
try { b = { ...b, ...JSON.parse(fs.readFileSync(path.join(home, 'behaviour.json'), 'utf8')) }; } catch { /* default */ }

const args = process.argv.slice(2);
const pi = args.indexOf('-p');
const prompt = pi >= 0 ? args[pi + 1] || '' : '';
fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({
  pid: process.pid, argv: args, at: new Date().toISOString(),
  leakedSecret: process.env.FAKE_PARENT_SECRET ?? null, token: process.env.FAKE_TOKEN ?? null,
  sawRotatorVars: Object.keys(process.env).filter((k) => k.startsWith('CLI_ROTATOR_')),
}) + '\n');

const outPath = (/^OUTPUT-PATH: (.+)$/m.exec(prompt) || [])[1]?.trim();
const sentinel = (/^SENTINEL: (.+)$/m.exec(prompt) || [])[1]?.trim() || 'LANE-COMPLETE';
const body = (n) => Array.from({ length: n }, (_, i) => `- finding ${i + 1}: the fake CLI wrote this line on purpose.`).join('\n');

async function main() {
  if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
  switch (b.mode) {
    case 'write':
      if (outPath) fs.writeFileSync(outPath, `# report\n\n${body(6)}\n\n${sentinel}\n`);
      process.stdout.write(JSON.stringify({ response: `Done. I wrote ${outPath ? path.basename(outPath) : 'nothing'}.` }) + '\n');
      return b.exitCode ?? 0;
    case 'nowrite':
      process.stdout.write(JSON.stringify({ response: 'Done. I have written the file as asked.' }) + '\n');
      return b.exitCode ?? 0;
    case 'stub':
      if (outPath) fs.writeFileSync(outPath, `todo\n${sentinel}\n`);
      process.stdout.write('{"response":"Done."}\n');
      return b.exitCode ?? 0;
    case 'nosentinel':
      if (outPath) fs.writeFileSync(outPath, `# report\n\n${body(10)}\n`);
      process.stdout.write('{"response":"Done."}\n');
      return b.exitCode ?? 0;
    case 'wall':
      process.stderr.write(`Error: Individual quota reached for this account. Resets in ${b.resetIn || '2h0m0s'}.\n`);
      return b.exitCode ?? 1;
    case 'fail':
      process.stderr.write('Error: something unrelated to quota went wrong\n');
      return b.exitCode ?? 1;
    case 'hang':
      process.stdout.write('working...\n');
      setInterval(() => {}, 1000);
      return null;
    default:
      process.stderr.write(`fake-cli: unknown mode ${b.mode}\n`);
      return 40;
  }
}
main().then((code) => { if (code !== null) process.exit(code); });
