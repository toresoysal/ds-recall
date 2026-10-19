#!/usr/bin/env node
/*
 * DS-ReCall — LIVE check of the commit-gate with a real Claude Code session (0.3.0).
 * Why: the gate's JSON output was checked against Claude Code's documentation and against our own
 * test harness, but neither proves that Claude Code accepts the shape. "The documentation says so"
 * is not a measurement. This script is how you (or we) measure it.
 *
 * It builds two throw-away git repos that contain one ORPHAN note, loads the plugin with --plugin-dir,
 * asks a headless `claude -p` to run `git commit`, and judges from the evidence Claude Code itself emits
 * (--output-format stream-json --include-hook-events) plus the real git history:
 *
 *   A  default config (no gateCommit key) → the commit MUST go through and the PreToolUse hook output MUST say "NOT blocked"
 *   B  "gateCommit": "block"              → the commit MUST be refused (permissionDecision deny) and nothing committed
 *
 * It needs a LOGGED-IN claude (run it in your own terminal; a desktop-app session is not shared).
 * Costs two tiny model calls.
 *
 *   node scripts/live-check-gate.js [--claude <path-to-claude>] [--model <alias>] [--keep]
 *   node scripts/live-check-gate.js --parse <stream.jsonl> --expect warn|block --commits <n>   (re-judge a saved stream; no model)
 *
 * Status: the judging logic is tested on streams built from the real gate output (accepts the right
 * evidence, rejects deny / "allow" / no hook / wrong commit count, reports "not logged in" as UNMEASURED).
 * The LIVE half, a real `claude -p` session, had not been run by the authors when this shipped.
 *
 * Exit: 0 both scenarios proven · 1 a scenario FAILED · 3 could not measure (not logged in, claude missing, timeout)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) ? args[i + 1] : d; };
const PLUGIN = path.resolve(__dirname, '..');            // the plugin folder this script ships in

/* ------------------------------------------------------------------ judging */

function parseStream(text) {
  const events = [];
  for (const l of text.split(/\r?\n/)) { if (!l.trim()) continue; try { events.push(JSON.parse(l)); } catch (_) {} }
  const pre = events.filter(o => o.type === 'system' && o.subtype === 'hook_response' && o.hook_event === 'PreToolUse');
  const result = events.filter(o => o.type === 'result').pop() || {};
  const resultText = String(result.result || '');
  const notLoggedIn = /not logged in|please run \/login/i.test(resultText) || events.some(o => o.type === 'assistant' && JSON.stringify(o.message && o.message.content || '').match(/Not logged in/i));
  return { events: events.length, preOutputs: pre.map(o => String(o.output || '')), resultText, notLoggedIn };
}

function judge(stream, expect, commits) {
  if (stream.notLoggedIn) return { verdict: 'UNMEASURED', why: 'claude is not logged in (run this in your own, logged-in terminal)' };
  if (stream.events === 0) return { verdict: 'UNMEASURED', why: 'no stream output at all' };
  const all = stream.preOutputs.join('\n');
  if (expect === 'warn') {
    const warned = /NOT blocked/.test(all);
    const denied = /"permissionDecision"\s*:\s*"deny"/.test(all);
    const allowed = /"permissionDecision"\s*:\s*"allow"/.test(all);
    if (!stream.preOutputs.length) return { verdict: 'FAIL', why: 'no PreToolUse hook ran at all (was the plugin loaded? did Claude run git commit?)' };
    if (!warned) return { verdict: 'FAIL', why: 'the hook output does not contain the "NOT blocked" warning: ' + all.slice(0, 200) };
    if (denied) return { verdict: 'FAIL', why: 'warn mode produced a deny' };
    if (allowed) return { verdict: 'FAIL', why: 'warn mode produced permissionDecision "allow" (would skip the permission prompt)' };
    if (commits !== 2) return { verdict: 'FAIL', why: 'expected the commit to go through (2 commits), found ' + commits };
    return { verdict: 'OK', why: 'warning delivered by the hook, no permission decision, commit went through' };
  }
  const denied = /"permissionDecision"\s*:\s*"deny"/.test(all) && /Commit blocked/.test(all);
  if (!stream.preOutputs.length) return { verdict: 'FAIL', why: 'no PreToolUse hook ran at all' };
  if (!denied) return { verdict: 'FAIL', why: 'block mode did not deny: ' + all.slice(0, 200) };
  if (commits !== 1) return { verdict: 'FAIL', why: 'a blocked commit must leave 1 commit, found ' + commits };
  return { verdict: 'OK', why: 'hook denied the commit and nothing was committed' };
}

/* ------------------------------------------------------------------- --parse */

if (args.includes('--parse')) {
  const stream = parseStream(fs.readFileSync(argOf('--parse'), 'utf8'));
  const j = judge(stream, argOf('--expect', 'warn'), Number(argOf('--commits', '0')));
  console.log(j.verdict + ' — ' + j.why);
  process.exit(j.verdict === 'OK' ? 0 : j.verdict === 'FAIL' ? 1 : 3);
}

/* --------------------------------------------------------------------- live */

const CLAUDE = argOf('--claude', process.env.CLAUDE_BIN || 'claude');
const MODEL = argOf('--model', null);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-live-'));
const git = (d, ...a) => spawnSync('git', ['-C', d].concat(a), { encoding: 'utf8' });

function repo(name, config) {
  const d = path.join(base, name);
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  git(d, 'init', '-q'); git(d, 'config', 'user.name', 'live-check'); git(d, 'config', 'user.email', 'live@example.com');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# index that links nothing\n');
  fs.writeFileSync(path.join(d, 'docs', 'orphan.md'), '# a note no index references\n');
  if (config) { fs.mkdirSync(path.join(d, '.claude'), { recursive: true }); fs.writeFileSync(path.join(d, '.claude', 'ds-recall.config.json'), JSON.stringify(config)); }
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}

function run(d, tag) {
  const cmdArgs = ['-p', 'Run exactly this shell command and reply with only its exit status and output: git commit --allow-empty -m gate-live-test',
    '--plugin-dir', PLUGIN, '--setting-sources', 'project', '--allowedTools', 'Bash(git commit:*)',
    '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--max-turns', '6'];
  if (MODEL) cmdArgs.push('--model', MODEL);
  const r = spawnSync(CLAUDE, cmdArgs, { cwd: d, encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && !/\.exe$/i.test(CLAUDE) });
  const file = path.join(base, tag + '.stream.jsonl');
  fs.writeFileSync(file, r.stdout || '');
  return { r, file };
}

const scenarios = [
  { tag: 'A-default', expect: 'warn', config: null, commits: 2, label: 'default config (no gateCommit key)' },
  { tag: 'B-block', expect: 'block', config: { gateCommit: 'block' }, commits: 1, label: '"gateCommit": "block"' }
];
let failed = 0, unmeasured = 0;
console.log('DS-ReCall live check of the commit-gate · plugin ' + PLUGIN + '\nclaude: ' + CLAUDE + (MODEL ? ' · model ' + MODEL : '') + '\n');
for (const s of scenarios) {
  const d = repo(s.tag, s.config);
  const { r, file } = run(d, s.tag);
  if (r.error) { unmeasured++; console.log('? ' + s.label + ' — could not start claude: ' + r.error.message); continue; }
  const count = Number((git(d, 'rev-list', '--count', 'HEAD').stdout || '0').trim());
  const j = judge(parseStream(r.stdout || ''), s.expect, count);
  const mark = j.verdict === 'OK' ? '✓' : j.verdict === 'FAIL' ? '✗' : '?';
  console.log(mark + ' ' + s.label + ' — ' + j.verdict + ': ' + j.why + '\n    commits in repo: ' + count + ' · stream saved: ' + file);
  if (j.verdict === 'FAIL') failed++; else if (j.verdict === 'UNMEASURED') unmeasured++;
}
if (!args.includes('--keep')) console.log('\n(temp repos are kept so you can inspect the saved streams: ' + base + ' — delete when done)');
console.log('\nRESULT: ' + (failed ? 'FAIL' : unmeasured ? 'UNMEASURED (no verdict)' : 'OK'));
process.exit(failed ? 1 : unmeasured ? 3 : 0);
