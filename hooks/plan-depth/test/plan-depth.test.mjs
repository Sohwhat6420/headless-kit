// Offline tests: the hook runs as a child process with fixture stdin JSON. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transcriptStats, planGaps, mergeConfig, reminderText } from '../plan-depth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'plan-depth.mjs');
const FIX = path.join(HERE, 'fixtures');
const plan = (n) => fs.readFileSync(path.join(FIX, n + '.md'), 'utf8');
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-depth-test-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function run(input, { state = tmp(), config = null, raw = false } = {}) {
  const env = { ...process.env, HEADLESS_KIT_STATE_DIR: state };
  delete env.PLAN_DEPTH_CONFIG;
  if (config) {
    const p = path.join(state, 'cfg.json');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(p, typeof config === 'string' ? config : JSON.stringify(config));
    env.PLAN_DEPTH_CONFIG = p;
  }
  const t = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: raw ? input : JSON.stringify(input), encoding: 'utf8', env, windowsHide: true, timeout: 20000 });
  // The one property that must hold for every output: never auto-approve a plan.
  assert.ok(!/"permissionDecision"\s*:\s*"allow"/.test(r.stdout), 'must never output permissionDecision "allow"');
  assert.equal(r.status, 0, 'always exits 0');
  return { out: r.stdout, json: r.stdout ? JSON.parse(r.stdout) : null, ms: Date.now() - t };
}
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const exit = (planText, extra = {}) => ({
  session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', permission_mode: 'plan',
  tool_input: { plan: planText }, ...extra,
});
const prompt = (text, extra = {}) => ({
  session_id: 'sess-p', hook_event_name: 'UserPromptSubmit', permission_mode: 'plan', prompt_id: 'p1', prompt: text, ...extra,
});
const bigPlan = (succession) => plan('full').replace('## Verification log',
  Array.from({ length: 8 }, (_, i) => `### ${i + 4}. Extra stage ${i + 4}\n\n1. Do it.\n`).join('\n') + '\n## Verification log')
  + (succession ? `\n## Context and succession\n\n${succession}\n` : '');

test('gate: a thin plan warns with systemMessage + additionalContext, never a decision', () => {
  const r = run(exit(plan('thin')));
  assert.ok(r.json.systemMessage.startsWith('Plan-depth: 8 gaps'));
  assert.ok(r.json.systemMessage.length <= 600);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(!('permissionDecision' in r.json.hookSpecificOutput));
  assert.match(ctx(r), /How \(numbered build steps\) for: Data import; Summary report; CSV export/);
  for (const s of ['Verification log', 'Unknowns -> tests', 'Questions log', 'Reviewed-by:', 'Dispatch plan', 'Prior art', 'Coverage checklist']) assert.ok(ctx(r).includes(s), s);
  assert.ok(ctx(r).endsWith('(Warn only; nothing is blocked.)'));
});

test('gate: a complete plan and a trivial plan are silent', () => {
  assert.equal(run(exit(plan('full'))).out, '');
  assert.equal(run(exit(plan('trivial'))).out, '');
});

test('gate: reads planFilePath when tool_input.plan is absent or empty', () => {
  const r = run(exit('', { tool_input: { plan: '', planFilePath: path.join(FIX, 'thin.md') } }));
  assert.match(ctx(r), /Dispatch plan section/);
  const r2 = run(exit('', { tool_input: { planFilePath: path.join(FIX, 'full.md') } }));
  assert.equal(r2.out, '');
});

test('gate: names exactly the missing sections', () => {
  const p = plan('full').replace(/## Prior art[\s\S]*$/, '');
  const r = run(exit(p));
  const items = ctx(r).split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(items, ['- Prior art section', '- Coverage checklist section']);
});

test('gate: section content rules (entries, sources, table, mentions)', () => {
  const cfg = mergeConfig(null);
  const lessVerified = plan('full').replace(/\| [3-6] \|.*\n/g, '');
  assert.deepEqual(planGaps(lessVerified, cfg), ['Verification log: only 2 of 5 entries have a verdict plus evidence (URL, path:line or probe)']);
  const fewSources = plan('full').replace(/- https:\/\/www\.npmjs[^\n]*\n/, '');
  assert.deepEqual(planGaps(fewSources, cfg), ['Prior art: 2 sources, need >= 3 (or a "searched ...: nothing relevant" line)']);
  const escaped = fewSources.replace('## Prior art\n', '## Prior art\n\nSearched npm and GitHub for CSV summarisers: nothing relevant.\n');
  assert.deepEqual(planGaps(escaped, cfg), []);
  const noReason = plan('full').replace('needs a visual check in a spreadsheet app', '');
  assert.deepEqual(planGaps(noReason, cfg), ['Dispatch plan: rows needing a reason have none: Export']);
  const noLoad = plan('full').replace(/Load line per phase[^\n]*\n/, '');
  assert.deepEqual(planGaps(noLoad, cfg), ['Dispatch plan missing: load line per phase']);
  const noRollback = plan('full').replace(/\| Rollback and undo[^\n]*\n/, '');
  assert.deepEqual(planGaps(noRollback, cfg), ['Coverage checklist missing: rollback']);
  const noQuestions = plan('full').replace(/## Questions log[\s\S]*?(?=## Dispatch)/, 'There are no open decisions.\n\n');
  assert.deepEqual(planGaps(noQuestions, cfg), []);
});

test('gate: big plans need Context and succession; small plans do not', () => {
  const cfg = mergeConfig(null);
  assert.deepEqual(planGaps(bigPlan(null), cfg), ['Context and succession section']);
  const complete = 'Baseline: a fresh session measured 38k tokens.\nHand-over points: after stage 3 and stage 7.\nStages 1-3 run in this session, 4-7 in a successor session.';
  assert.deepEqual(planGaps(bigPlan(complete), cfg), []);
  const noHandover = 'Baseline: 38k tokens.\nStages 1-3 run in this session, the rest in a successor session.';
  assert.deepEqual(planGaps(bigPlan(noHandover), cfg), ['Context and succession missing: named hand-over points']);
  // exactly 10 stages is not big
  const ten = bigPlan(null).replace('### 11. Extra stage 11', '#### 11. Extra stage 11');
  assert.deepEqual(planGaps(ten, cfg), []);
});

test('config: custom sections, disabled sections, thresholds, bad file falls back', () => {
  const custom = { sections: [{ id: 'risks', title: 'Risks', heading: 'Risks', hint: 'what could go wrong' }], thresholds: { minHeadings: 1 } };
  assert.equal(run(exit(plan('thin')), { config: custom }).out, '', 'thin has a Risks section');
  const r = run(exit(plan('full')), { config: custom });
  assert.match(ctx(r), /^- Risks section$/m);
  const disabled = run(exit(plan('full').replace(/## Prior art[\s\S]*$/, '')), { config: { disabledSections: ['prior', 'coverage'] } });
  assert.equal(disabled.out, '');
  const bad = run(exit(plan('thin')), { config: '{not json' });
  assert.match(ctx(bad), /Dispatch plan section/, 'defaults still apply');
  assert.ok(reminderText(mergeConfig(custom)).includes('1 Risks: what could go wrong'));
});

test('gate: opt-in deny mode refuses ExitPlanMode, then falls back to warning', () => {
  const state = tmp();
  const config = { gate: { onGaps: 'deny', maxDenialsPerSession: 2 } };
  const a = run(exit(plan('thin')), { state, config });
  const b = run(exit(plan('thin')), { state, config });
  const c = run(exit(plan('thin')), { state, config });
  assert.equal(a.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(a.json.hookSpecificOutput.permissionDecisionReason, /call ExitPlanMode again/);
  assert.equal(b.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!('permissionDecision' in c.json.hookSpecificOutput), 'third time: warn only');
  assert.match(ctx(c), /Warn only/);
  const noSid = run(exit(plan('thin'), { session_id: undefined }), { config });
  assert.ok(!('permissionDecision' in noSid.json.hookSpecificOutput), 'no session id: never deny');
});

function transcript(dir, { compactions, tokens, first = 'Plan a small reporting tool.' }) {
  const lines = [{ type: 'user', message: { role: 'user', content: first } }];
  for (let i = 0; i < compactions; i++) lines.push({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
  lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 10 } } });
  const p = path.join(dir, `t-${compactions}-${tokens}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('hand-over check: needs BOTH enough compactions and enough context, warns once per session', () => {
  const state = tmp();
  const full = plan('full');
  assert.equal(run(exit(full, { transcript_path: transcript(state, { compactions: 2, tokens: 200000 }) }), { state }).out, '');
  assert.equal(run(exit(full, { transcript_path: transcript(state, { compactions: 3, tokens: 150000 }) }), { state }).out, '');
  const tp = transcript(state, { compactions: 3, tokens: 200000 });
  const r = run(exit(full, { transcript_path: tp }), { state });
  assert.match(ctx(r), /Consider handing execution to a fresh session after approval \(3 compactions, 200k tokens of context\)/);
  assert.equal(run(exit(full, { transcript_path: tp }), { state }).out, '', 'second time in the session: silent');
  const other = run(exit(full, { transcript_path: tp, session_id: 'sess-2' }), { state });
  assert.match(ctx(other), /3 compactions/);
  const started = transcript(tmp(), { compactions: 3, tokens: 200000, first: 'Continue from HANDOVER.md' });
  assert.equal(run(exit(full, { transcript_path: started, session_id: 'sess-3' }), { config: { handover: { skipIfFirstPromptMatches: 'HANDOVER\\.md' } } }).out, '');
  assert.equal(run(exit(full, { transcript_path: tp, session_id: 'sess-4' }), { config: { handover: { enabled: false } } }).out, '');
});

test('transcriptStats: counts a compaction marker split across the 1 MB chunk boundary exactly once', () => {
  const dir = tmp();
  const p = path.join(dir, 'split.jsonl');
  const marker = JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n';
  const at = (1 << 20) - 20; // the "subtype" key straddles the boundary
  const pad = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(at - 60) } });
  const filler = pad + ' '.repeat(Math.max(0, at - pad.length - 1)) + '\n';
  fs.writeFileSync(p, filler + marker + marker + JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5 } } }) + '\n');
  const s = transcriptStats(p);
  assert.equal(s.compactions, 2);
  assert.equal(s.contextTokens, 5);
});

test('reminder: full list on the first plan-mode human prompt, then one short line', () => {
  const state = tmp();
  const a = run(prompt('Plan the export feature'), { state });
  assert.equal(a.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ctx(a), /^\[plan-depth\] Plan mode: a plan with 3\+ tasks or features needs:/);
  assert.match(ctx(a), /9 Context and succession:/);
  assert.ok(ctx(a).length < 1500);
  const b = run(prompt('And make it fast'), { state });
  assert.match(ctx(b), /^\[plan-depth\] The plan standard applies: How, Verification log/);
  assert.ok(ctx(b).length < 250);
  const c = run(prompt('New session', { session_id: 'sess-other' }), { state });
  assert.match(ctx(c), /Plan mode: a plan/);
});

test('reminder: silent outside plan mode and for non-human prompts', () => {
  assert.equal(run(prompt('Plan it', { permission_mode: 'default' })).out, '');
  assert.equal(run(prompt('<task-notification><status>completed</status></task-notification>')).out, '');
  assert.equal(run(prompt('<scheduled-task name="x">run</scheduled-task>')).out, '');
  assert.equal(run(prompt('You have hit your usage limit. Continue.')).out, '');
  assert.equal(run(prompt('   ')).out, '');
  assert.equal(run(prompt('Plan it', { prompt_id: undefined }), { config: { reminder: { requirePromptId: true } } }).out, '');
  assert.equal(run(prompt('Plan it'), { config: { reminder: { enabled: false } } }).out, '');
});

test('fails open: malformed, empty or unrelated input gives no output and exit 0', () => {
  assert.equal(run('not json', { raw: true }).out, '');
  assert.equal(run('', { raw: true }).out, '');
  assert.equal(run('[1,2]', { raw: true }).out, '');
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).out, '');
  assert.equal(run({ hook_event_name: 'Stop' }).out, '');
  assert.equal(run(exit('', { tool_input: { planFilePath: path.join(FIX, 'missing.md') } })).out, '');
  assert.equal(run(exit(plan('thin'), { transcript_path: path.join(FIX) })).json.systemMessage.length > 0, true, 'a directory as transcript is ignored');
});

test('performance: a 1,500-line plan is checked quickly', () => {
  const big = plan('thin').repeat(Math.ceil(1500 / plan('thin').split('\n').length));
  const r = run(exit(big));
  assert.ok(r.json.systemMessage);
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

test('--help and --check work as a CLI', () => {
  const h = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /never outputs permissionDecision "allow"/i);
  const c = spawnSync(process.execPath, [HOOK, '--check', path.join(FIX, 'thin.md')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HEADLESS_KIT_STATE_DIR: tmp() } });
  assert.equal(JSON.parse(c.stdout).gaps.length, 8);
});

test('examples/config.example.json parses and drives the gate', () => {
  const example = fs.readFileSync(path.join(HERE, '..', 'examples', 'config.example.json'), 'utf8');
  const r = run(exit(plan('thin')), { config: example });
  assert.ok(!/Dispatch plan/.test(ctx(r)), 'disabled in the example');
  assert.ok(!/Risks/.test(ctx(r)), 'thin.md has a Risks section');
  assert.match(ctx(r), /Verification log section/);
});
