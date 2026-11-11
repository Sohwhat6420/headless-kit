// Root test runner: runs every item's `npm test` equivalent from its own directory.
// Items live at tools/<category>/<tool>/ and hooks/<hook>/; each has a package.json with a "test" script.
// Items that only support some platforms ("os" in package.json) are skipped (reported, not failed) elsewhere.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2]; // optional: run only items whose path contains this text

function items() {
  const out = [];
  const subdirs = (d) => (existsSync(d) ? readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()).sort() : []);
  for (const cat of subdirs(join(root, 'tools'))) for (const t of subdirs(join(root, 'tools', cat))) out.push(join(root, 'tools', cat, t));
  for (const h of subdirs(join(root, 'hooks'))) out.push(join(root, 'hooks', h));
  return out.filter((d) => existsSync(join(d, 'package.json')));
}

let failed = 0;
let ran = 0;
for (const dir of items()) {
  const name = relative(root, dir).replace(/\\/g, '/');
  if (only && !name.includes(only)) continue;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.os && !pkg.os.includes(process.platform)) {
    console.log(`\n=== ${name}: SKIPPED (supports ${pkg.os.join(', ')}; this is ${process.platform}) ===`);
    continue;
  }
  const script = pkg.scripts && pkg.scripts.test;
  if (!script) { console.log(`\n=== ${name}: no test script ===`); failed++; continue; }
  console.log(`\n=== ${name}: ${script} ===`);
  const args = script.replace(/^node\s+/, '').split(/\s+/);
  const r = spawnSync(process.execPath, args, { cwd: dir, stdio: 'inherit', windowsHide: true });
  ran++;
  if (r.status !== 0) { console.log(`=== ${name}: FAILED (exit ${r.status}) ===`); failed++; }
  else console.log(`=== ${name}: ok ===`);
}
console.log(failed ? `\n${failed} item(s) failed` : `\nall ${ran} item test suites passed`);
process.exit(failed ? 1 : 0);
