// Root test runner: runs every tool's `npm test` equivalent from its own directory.
// Tools that only support Windows are skipped (reported, not failed) on other platforms.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = join(root, 'tools');
let failed = 0;

for (const name of readdirSync(toolsDir).sort()) {
  const dir = join(toolsDir, name);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.os && !pkg.os.includes(process.platform)) {
    console.log(`\n=== ${name}: SKIPPED (supports ${pkg.os.join(', ')}; this is ${process.platform}) ===`);
    continue;
  }
  const script = pkg.scripts && pkg.scripts.test;
  if (!script) { console.log(`\n=== ${name}: no test script ===`); failed++; continue; }
  console.log(`\n=== ${name}: ${script} ===`);
  const args = script.replace(/^node\s+/, '').split(/\s+/);
  const r = spawnSync(process.execPath, args, { cwd: dir, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) { console.log(`=== ${name}: FAILED (exit ${r.status}) ===`); failed++; }
  else console.log(`=== ${name}: ok ===`);
}
console.log(failed ? `\n${failed} tool(s) failed` : '\nall tool tests passed');
process.exit(failed ? 1 : 0);
