// Reset the offline demo: fresh state, and three fake accounts where alpha answers with a quota wall.
// node examples/demo-setup.mjs   then follow the commands in the README's demo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.demo');
fs.rmSync(root, { recursive: true, force: true });
const accounts = { alpha: { mode: 'wall', resetIn: '2h0m0s' }, beta: { mode: 'write' }, gamma: { mode: 'write' } };
for (const [name, behaviour] of Object.entries(accounts)) {
  fs.mkdirSync(path.join(root, 'homes', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'homes', name, 'behaviour.json'), JSON.stringify(behaviour));
}
console.log(JSON.stringify({ ok: true, demo: '.demo', accounts }));
