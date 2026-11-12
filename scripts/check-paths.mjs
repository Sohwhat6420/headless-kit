#!/usr/bin/env node
// Scan tracked working-tree text, including ignored files already in Git's index.
// CHECK_PATHS_WINDOWS_USER optionally forbids a known username even outside a path.
// Output includes locations and rules only; matched text is never echoed.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const placeholder = /^(?:<[^>]+>|%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})$/;
const profiles = [
  ['windows-user-profile', /[a-z]:[\\/]+Users[\\/]+([^\\/\r\n"']+)[\\/]+/gi],
  ['macos-user-profile', /(?<![A-Za-z]:)\/Users\/([^/\r\n"']+)\//g],
  ['linux-user-profile', /\/home\/([^/\r\n"']+)\//g],
];

function text(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim();
  const files = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const username = process.env.CHECK_PATHS_WINDOWS_USER;
  const rules = [...profiles];
  if (username) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push(['windows-username', new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`, 'gi')]);
  }
  const findings = [];
  let scanned = 0;
  for (const file of new Set(files)) {
    const path = resolve(root, file);
    let bytes;
    try {
      bytes = lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // Tracked file deleted in the working tree.
      throw e;
    }
    const content = text(bytes);
    if (content === null) continue;
    scanned++;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      for (const [rule, pattern] of rules) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          if (match[1] && placeholder.test(match[1])) continue;
          findings.push({ file, line: index + 1, column: match.index + 1, rule });
        }
      }
    }
  }
  console.log(JSON.stringify({ scanned, findings }));
  process.exitCode = findings.length ? 1 : 0;
} catch {
  console.error('check-paths: unable to scan tracked text files');
  process.exitCode = 2;
}
