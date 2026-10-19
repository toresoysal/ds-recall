#!/usr/bin/env node
/*
 * DS-ReCall — init / upgrade (0.3): one command instead of eight copy commands.
 *
 * Why it exists (measured 2026-10-18): setting a project up meant ~8 manual copy commands, and after
 * a plugin upgrade the three project-local scripts went stale silently, because /ds-recall:wrap and
 * /ds-recall:status run THOSE copies, not the plugin's own.
 *
 *   node <plugin>/scripts/init.js [projectDir]                    set a project up — NEVER overwrites a file you already have
 *   node <plugin>/scripts/init.js [projectDir] --upgrade          re-sync ONLY validate.js, wrap-prep.js, session-lib.js
 *   node <plugin>/scripts/init.js [projectDir] --dry-run          print what would happen, write nothing
 *   node <plugin>/scripts/init.js [projectDir] --append-pointers  you already have a CLAUDE.md: append the two lines that stop
 *                                                                 the new docs/DECISIONS.md + docs/TIMELINE.md being ORPHANS
 *   node <plugin>/scripts/init.js [projectDir] --disable-auto-memory   merge {"autoMemoryEnabled": false} into .claude/settings.json
 *                                                                 (never done silently: without this flag it is only reported)
 *
 * projectDir defaults to $CLAUDE_PROJECT_DIR, then the current directory. It must already exist.
 * No dependencies. No network. Exit: 0 ok (a dry run is ok) · 1 refused or an action failed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.resolve(__dirname, '..');          // the plugin folder this script lives in

const KNOWN = ['--upgrade', '--dry-run', '--append-pointers', '--disable-auto-memory', '--help', '-h'];
const args = process.argv.slice(2);
const FLAG = {
  upgrade: args.includes('--upgrade'),
  dry: args.includes('--dry-run'),
  pointers: args.includes('--append-pointers'),
  autoMemory: args.includes('--disable-auto-memory'),
  help: args.includes('--help') || args.includes('-h')
};

const SCRIPTS = ['validate.js', 'wrap-prep.js', 'session-lib.js'];
const TEMPLATES = [
  ['templates/CLAUDE.md', 'CLAUDE.md'],
  ['templates/DECISIONS.md', 'docs/DECISIONS.md'],
  ['templates/TIMELINE.md', 'docs/TIMELINE.md'],
  ['templates/ds-recall.config.json', '.claude/ds-recall.config.json']
];
const SCRIPT_PAIRS = SCRIPTS.map(f => ['scripts/' + f, '.claude/scripts/' + f]);
const UPGRADE_SET = SCRIPT_PAIRS;                   // --upgrade touches these three files and nothing else
const GI_HEADER = '# DS-ReCall runtime (backups hold full session transcripts - never commit them)';
const GI_LINES = ['.claude/active/', '.claude/backups/', '.claude/.index.lock', '_memory-graph/'];
const POINTERS = [
  ['docs/DECISIONS.md', '- Decisions (dated, reasoned) -> docs/DECISIONS.md'],
  ['docs/TIMELINE.md', '- Milestones -> docs/TIMELINE.md']
];

const rows = [];
function rec(status, rel, detail) { rows.push({ status, rel, detail: detail || '' }); }
const WOULD = { created: 'create', updated: 'update', appended: 'append' };
const will = s => (FLAG.dry ? 'would ' + (WOULD[s] || s) : s);
const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 8);
const show = p => String(p).replace(/\\/g, '/');

/* ------------------------------------------------------------------ writing */

// temp file + rename: an interrupted write can never leave a half-written (or emptied) user file.
function writeFileSafe(dst, data) {
  if (FLAG.dry) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.dsr-tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dst);
}
function appendSafe(dst, text) {
  if (FLAG.dry) return;
  fs.appendFileSync(dst, text);
}

/* mode 'create': never touch an existing file · mode 'sync': make it byte-equal to the plugin's copy */
function put(srcRel, dstRel, mode, noteDiffers) {
  try {
    const data = fs.readFileSync(path.join(SRC, srcRel));
    const dst = path.join(project, dstRel);
    if (!fs.existsSync(dst)) { writeFileSafe(dst, data); return rec(will('created'), dstRel); }
    const cur = fs.readFileSync(dst);
    const same = cur.equals(data);
    if (mode === 'sync') {
      if (same) return rec('unchanged', dstRel);
      writeFileSafe(dst, data);
      return rec(will('updated'), dstRel, sha(cur) + ' -> ' + sha(data));
    }
    return rec('kept', dstRel, (noteDiffers && !same) ? 'differs from this plugin version — run with --upgrade to re-sync' : '');
  } catch (e) { return rec('error', dstRel, String(e.message).slice(0, 100)); }
}

/* ---------------------------------------------------------------- .gitignore */

function gitignore() {
  const p = path.join(project, '.gitignore');
  try {
    const had = fs.existsSync(p);
    const text = had ? fs.readFileSync(p, 'utf8') : '';
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';                 // append in the file's own line ending
    const present = new Set(text.split(/\r?\n/).map(l => l.trim()));
    // a rule that already ignores the whole .claude/ folder covers the three .claude/ lines
    const wholeClaude = ['.claude', '.claude/', '/.claude', '/.claude/'].some(l => present.has(l));
    const missing = GI_LINES.filter(l => !present.has(l) && !(wholeClaude && l.startsWith('.claude/')));
    if (!missing.length) return rec('unchanged', '.gitignore', 'runtime lines already present');
    let add = '';
    if (text.length && !/\n$/.test(text)) add += eol;
    if (!present.has(GI_HEADER)) add += (text.length ? eol : '') + GI_HEADER + eol;
    add += missing.join(eol) + eol;
    if (had) appendSafe(p, add); else writeFileSafe(p, Buffer.from(add, 'utf8'));
    rec(will(had ? 'appended' : 'created'), '.gitignore', 'added ' + missing.join(' '));
  } catch (e) { rec('error', '.gitignore', String(e.message).slice(0, 100)); }
}

/* -------------------------------------------------------------- auto-memory */

// Never switched off silently: without --disable-auto-memory this only REPORTS the state.
function autoMemory() {
  const sp = path.join(project, '.claude', 'settings.json');
  let obj = null, rawText = null;
  try {
    if (fs.existsSync(sp)) {
      rawText = fs.readFileSync(sp, 'utf8');
      obj = JSON.parse(rawText.replace(/^﻿/, ''));
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not a JSON object');
    }
  } catch (e) {
    rec('error', '.claude/settings.json', 'not valid JSON (' + String(e.message).slice(0, 60) + ') — left untouched');
    return 'unknown';
  }
  const off = !!process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || !!(obj && obj.autoMemoryEnabled === false);
  if (!FLAG.autoMemory) return off ? 'off' : 'on';
  if (obj && obj.autoMemoryEnabled === false) { rec('unchanged', '.claude/settings.json', 'autoMemoryEnabled is already false'); return 'off'; }
  try {
    if (rawText !== null) {
      const bak = sp + '.dsr-backup';
      if (!fs.existsSync(bak)) writeFileSafe(bak, rawText);
    }
    const next = Object.assign({}, obj || {}, { autoMemoryEnabled: false });
    writeFileSafe(sp, JSON.stringify(next, null, 2) + '\n');
    rec(will(rawText === null ? 'created' : 'updated'), '.claude/settings.json',
      'autoMemoryEnabled: false' + (rawText !== null ? ' (original kept as settings.json.dsr-backup)' : ''));
    return 'off';
  } catch (e) { rec('error', '.claude/settings.json', String(e.message).slice(0, 100)); return 'unknown'; }
}

/* ------------------------------------------------------------------ pointers */

// An existing CLAUDE.md does not mention the decision log / timeline we just created → they are ORPHANS
// and a blocking commit-gate would stop every commit. Only for files WE created in this run.
function pointers(claudeExistedBefore) {
  if (!claudeExistedBefore) return;                 // our own template already links both files
  try {
    const claude = path.join(project, 'CLAUDE.md');
    const text = fs.readFileSync(claude, 'utf8');
    const created = new Set(rows.filter(r => /create/.test(r.status)).map(r => r.rel));
    const missing = POINTERS.filter(([p]) => created.has(p) && text.indexOf(p) === -1);
    if (!missing.length) return;
    const lines = missing.map(m => m[1]);
    if (!FLAG.pointers) return rec('todo', 'CLAUDE.md', 'ORPHAN risk — add these lines, or re-run with --append-pointers:\n      ' + lines.join('\n      '));
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    appendSafe(claude, (/\n$/.test(text) ? '' : eol) + eol + lines.join(eol) + eol);
    rec(will('appended'), 'CLAUDE.md', lines.length + ' pointer line(s) to the new docs');
  } catch (e) { rec('error', 'CLAUDE.md', String(e.message).slice(0, 100)); }
}

/* ---------------------------------------------------------------------- main */

function die(msg) { console.error('init: ' + msg); console.log('RESULT: REFUSED'); process.exit(1); }
function sameOrInside(parent, child) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }

if (FLAG.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n\/\*\n?/, '').replace(/^ \* ?/gm, '')); process.exit(0); }
const unknown = args.filter(a => a.startsWith('-') && !KNOWN.includes(a));
if (unknown.length) die('unknown option ' + unknown.join(' ') + ' (see --help)');
const positional = args.filter(a => !a.startsWith('-'));
const project = path.resolve(positional[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd());

let isDir = false; try { isDir = fs.statSync(project).isDirectory(); } catch (_) {}
if (!isDir) die('project folder does not exist: ' + show(project));
if (sameOrInside(SRC, project)) die('refusing to set up a project INSIDE the plugin folder (' + show(SRC) + ') — pass your own project folder');
try {
  const pj = JSON.parse(fs.readFileSync(path.join(project, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (pj && pj.name === 'ds-recall') die('that folder is the ds-recall plugin itself, not a project');
} catch (_) {}

let pluginVersion = '?';
try { pluginVersion = JSON.parse(fs.readFileSync(path.join(SRC, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch (_) {}

const claudeExistedBefore = fs.existsSync(path.join(project, 'CLAUDE.md'));
let memState = 'on';

if (FLAG.upgrade) {
  UPGRADE_SET.forEach(([s, d]) => put(s, d, 'sync'));
  if (!fs.existsSync(path.join(project, '.claude', 'ds-recall.config.json'))) {
    rec('todo', '.claude/ds-recall.config.json', 'this project has no DS-ReCall config yet — run init.js WITHOUT --upgrade for the full setup');
  }
} else {
  TEMPLATES.forEach(([s, d]) => put(s, d, 'create', false));
  SCRIPT_PAIRS.forEach(([s, d]) => put(s, d, 'create', true));
  gitignore();
  memState = autoMemory();
  pointers(claudeExistedBefore);
}

/* ------------------------------------------------------------------- report */

const mode = FLAG.upgrade ? 'upgrade' : 'setup';
console.log('DS-ReCall init — ' + mode + (FLAG.dry ? ' (DRY RUN: nothing is written)' : '') + ' · plugin ' + pluginVersion);
console.log('  project: ' + show(project));
console.log('  source : ' + show(SRC) + '\n');
const w = Math.max.apply(null, rows.map(r => r.status.length).concat([7]));
rows.forEach(r => console.log('  ' + r.status.padEnd(w) + '  ' + r.rel + (r.detail ? '  — ' + r.detail : '')));
const count = re => rows.filter(r => re.test(r.status)).length;
console.log('\n  ' + count(/create/) + (FLAG.dry ? ' to create · ' : ' created · ') + count(/update|append/) + (FLAG.dry ? ' to change · ' : ' changed · ')
  + count(/kept|unchanged/) + ' left as they were · ' + count(/^todo$/) + ' to do · ' + count(/^error$/) + ' errors');

if (!FLAG.upgrade) {
  console.log('\nNext:');
  console.log('  1. Edit CLAUDE.md: replace the <placeholders> (project name, one-paragraph summary, your hard rules). Keep it an INDEX.');
  console.log('  2. Built-in auto-memory: ' + (memState === 'off'
    ? 'off ✓'
    : memState === 'on' ? 'STILL ON — add {"autoMemoryEnabled": false} to .claude/settings.json (or re-run with --disable-auto-memory)'
      : 'could not be read (see above)'));
  console.log('  3. node .claude/scripts/validate.js    → expect RESULT: OK');
} else {
  console.log('\n  /ds-recall:wrap and /ds-recall:status run the project-local scripts, so they use this version from now on.');
}

if (!FLAG.dry && !FLAG.upgrade) {
  try {
    const { computeIntegrity } = require('./validate.js');
    const r = computeIntegrity(project);
    console.log('\nIntegrity now: referenced=' + r.referenced.size + ' broken=' + r.broken.length + ' orphan=' + r.orphans.length + ' unindexed=' + r.unindexed.length);
    r.broken.slice(0, 5).forEach(b => console.log('  BROKEN  ' + b));
    r.orphans.slice(0, 5).forEach(o => console.log('  ORPHAN  ' + o));
    if (r.broken.length + r.orphans.length + r.unindexed.length > 0) {
      console.log('  (the commit-gate only warns by default; set "gateCommit": "block" in .claude/ds-recall.config.json to enforce)');
    }
  } catch (e) { console.log('\nIntegrity not computed: ' + String(e.message).slice(0, 80)); }
}

const errors = count(/^error$/);
console.log('\nRESULT: ' + (errors ? 'FAIL (' + errors + ' error(s))' : (FLAG.dry ? 'DRY-RUN' : 'OK')));
process.exit(errors ? 1 : 0);
