import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const checker = fileURLToPath(new URL('./check-paths.mjs', import.meta.url));
const bad = JSON.parse(readFileSync(new URL('./fixtures/paths-bad.json', import.meta.url), 'utf8'));

test('scans tracked text, rejects profiles and optional username, and allows placeholders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-paths-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
  const run = (extra = {}) => {
    const env = { ...process.env, ...extra };
    // Isolate this temporary repository from callers running in a Git hook.
    for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
    const result = spawnSync(process.execPath, [checker], { cwd: dir, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.stderr, '');
    return { status: result.status, ...JSON.parse(result.stdout) };
  };
  try {
    git('init', '--quiet');
    copyFileSync(new URL('./fixtures/paths-good.txt', import.meta.url), join(dir, 'good.txt'));
    git('add', 'good.txt');
    assert.deepEqual(run({ CHECK_PATHS_WINDOWS_USER: '' }).findings, []);
    assert.equal(run({ CHECK_PATHS_WINDOWS_USER: '' }).status, 0);

    const paths = [bad.windows.join('\\'), bad.windows.join('/'), bad.windows.join('\\\\'), bad.macos.join('/'), bad.linux.join('/')];
    writeFileSync(join(dir, 'bad.txt'), paths.join('\n'));
    assert.equal(run({ CHECK_PATHS_WINDOWS_USER: '' }).status, 0, 'untracked files are excluded');
    git('add', 'bad.txt');
    const result = run({ CHECK_PATHS_WINDOWS_USER: '' });
    assert.equal(result.status, 1);
    assert.deepEqual(result.findings.map(({ file, line, rule }) => ({ file, line, rule })), [
      ...[1, 2, 3].map((line) => ({ file: 'bad.txt', line, rule: 'windows-user-profile' })),
      { file: 'bad.txt', line: 4, rule: 'macos-user-profile' },
      { file: 'bad.txt', line: 5, rule: 'linux-user-profile' },
    ]);
    assert.ok(!JSON.stringify(result).includes('fixture-user'), 'matched values are not printed');

    writeFileSync(join(dir, 'bad.txt'), 'account: fixture-user\n');
    assert.equal(run({ CHECK_PATHS_WINDOWS_USER: '' }).status, 0);
    assert.deepEqual(run({ CHECK_PATHS_WINDOWS_USER: 'fixture-user' }).findings.map((f) => f.rule), ['windows-username']);

    writeFileSync(join(dir, 'bad.txt'), Buffer.from([0, ...Buffer.from(paths[0])]));
    assert.equal(run({ CHECK_PATHS_WINDOWS_USER: '' }).status, 0, 'binary files are excluded');
    writeFileSync(join(dir, 'bad.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from(paths[4], 'utf16le')]));
    assert.equal(run({ CHECK_PATHS_WINDOWS_USER: '' }).status, 1, 'UTF-16 text is scanned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
