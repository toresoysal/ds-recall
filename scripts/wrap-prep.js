#!/usr/bin/env node
/*
 * DS-ReCall — wrap-prep (v0.2): the deterministic half of /wrap
 *
 * ── THE PROBLEM THIS SOLVES ──
 * /wrap was entirely model-driven. To flip one status line the model had to READ the whole
 * index, and to keep the root index trimmed it had to READ the whole history file. Measured
 * on the reference workspace, 2026-08-07:
 *
 *     .claude/SESSIONS_INDEX.md    93,0 KB   ~29.800 tok   (must be read to Edit one line)
 *     _sessions/00-INDEX.md        80,0 KB   ~25.600 tok   (must be read to prepend one line)
 *     .claude/CHILD_FEED.md        20,7 KB   ~ 6.600 tok
 *     CLAUDE.md + 2 side indexes   34,2 KB   ~10.900 tok
 *     ───────────────────────────────────────────────────
 *     forced reading per wrap     227,9 KB   ~72.900 tok    ← before a single word is written
 *
 * (file names above are from the workspace where this was measured; yours will differ.)
 *
 * That is the 15-20 minute, credit-burning wrap. None of it needs a language model:
 * flipping a status, moving the oldest line, appending a feed row and running integrity are
 * mechanical. This script does them in milliseconds and prints a ~40-line briefing, so the
 * model only spends tokens on the part that actually needs judgement: what happened and why.
 *
 * Token estimates use 3,2 bytes/token — a rough divisor for Turkish markdown, NOT a measured
 * tokenizer count. Byte figures are measured; token figures are labelled estimates.
 *
 * USAGE
 *   node wrap-prep.js <root> [--session <id>]                 report only (default, read-only)
 *   node wrap-prep.js <root> --gc                             also collect abandoned empty stubs
 *   node wrap-prep.js <root> --flip <sid8> --status CONSOLIDATED [--label "..."] [--summary "..."]
 *   node wrap-prep.js <root> --evict [--dry-run]              enforce the root-index line cap
 *   node wrap-prep.js <root> --child-feed "<line>"            append one row to the parent feed
 *   node wrap-prep.js <root> --json                           machine-readable report
 *
 * Exit codes: 0 = clean · 1 = integrity FAIL or an action failed · 3 = nothing to do
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./session-lib.js');

const BYTES_PER_TOKEN = 3.2; // labelled estimate, not a tokenizer

function argOf(argv, name, fallback) {
  const i = argv.indexOf(name);
  return (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : fallback;
}
function kb(n) { return (n / 1024).toFixed(1); }
function tok(n) { return Math.round(n / BYTES_PER_TOKEN); }
function sizeOf(p) { try { return fs.statSync(p).size; } catch (_) { return 0; } }

/* ------------------------------------------------------------------ evict */

const EVICT_DEFAULT = {
  file: 'CLAUDE.md',
  linePattern: '^- \\[S-',            // "- [S-xxxxxxx](path) · date · summary"
  maxLines: 6,
  targetFile: null,                   // e.g. "_sessions/00-INDEX.md"; null = report only
  targetAnchor: '^## '                // insert directly under the first heading matching this
};

/**
 * The root index grows by one session line per wrap and nothing ever removes them.
 * On this workspace that took CLAUDE.md to 97,8 KB (limit 16 KB) across 9 sessions;
 * pruning was planned 9 times and deferred 9 times, and the file grew every single time.
 * A rule that depends on someone remembering to delete is not a rule. This makes the
 * eviction mechanical: oldest line out, into the history file, in one move.
 */
function evict(root, cfg, dryRun) {
  const e = Object.assign({}, EVICT_DEFAULT, cfg.evict || {});
  const src = L.safeJoin(root, e.file, 'CLAUDE.md');
  const res = { ok: true, file: e.file, kept: 0, moved: [], target: e.targetFile, dryRun: !!dryRun, note: '' };
  if (!fs.existsSync(src)) { res.ok = false; res.note = 'source not found'; return res; }

  const re = new RegExp(e.linePattern);
  const lines = fs.readFileSync(src, 'utf8').split('\n');
  const hits = [];
  lines.forEach((l, i) => { if (re.test(l)) hits.push(i); });
  res.kept = hits.length;
  if (hits.length <= e.maxLines) { res.note = `${hits.length}/${e.maxLines} — within cap`; return res; }

  // session lines are written newest-first, so the surplus is at the BOTTOM of the block
  const surplus = hits.slice(e.maxLines);
  res.moved = surplus.map(i => lines[i]);

  if (dryRun) { res.note = `${surplus.length} line(s) would move`; return res; }

  if (e.targetFile) {
    const tgt = L.safeJoin(root, e.targetFile, e.targetFile);
    if (!fs.existsSync(tgt)) { res.ok = false; res.note = 'target not found: ' + e.targetFile; return res; }
    const t = fs.readFileSync(tgt, 'utf8').split('\n');
    const anchorRe = new RegExp(e.targetAnchor);
    let at = t.findIndex(l => anchorRe.test(l));
    at = at === -1 ? t.length : at + 1;
    // keep chronology: newest of the surplus lands first
    t.splice(at, 0, '', ...res.moved);
    fs.writeFileSync(tgt, t.join('\n'));
  } else {
    res.note = 'no targetFile configured — lines removed from source only were NOT moved';
    res.ok = false;
    return res;
  }

  const survivors = lines.filter((_, i) => surplus.indexOf(i) === -1);
  fs.writeFileSync(src, survivors.join('\n'));
  res.note = `${surplus.length} line(s) moved to ${e.targetFile}`;
  res.kept = e.maxLines;
  return res;
}

/* ------------------------------------------------------------------ report */

function build(root) {
  const cfg = L.loadConfig(root);
  const sessionsAbs = L.safeJoin(root, cfg.sessionsDir, L.DEFAULTS.sessionsDir);
  const idxFile = L.indexPath(root, cfg);

  const r = { root, cfg, warnings: [] };

  /* index / history / feed sizes — the wrap read surface */
  const surface = [
    ['CLAUDE.md', path.join(root, 'CLAUDE.md')],
    ['SESSIONS_INDEX', idxFile],
    ['CHILD_FEED', path.join(root, '.claude', 'CHILD_FEED.md')]
  ];
  if (cfg.evict && cfg.evict.targetFile) surface.push(['history', L.safeJoin(root, cfg.evict.targetFile, cfg.evict.targetFile)]);
  r.surface = surface.map(([n, p]) => ({ name: n, bytes: sizeOf(p), exists: fs.existsSync(p) }));

  /* stub inventory */
  let names = [];
  try { names = fs.readdirSync(sessionsAbs).filter(L.isAutoStubName); } catch (_) {}
  let empty = 0, withWork = 0;
  for (const n of names) { const i = L.readStubInfo(sessionsAbs, n); if (!i) continue; i.empty ? empty++ : withWork++; }
  r.stubs = { total: names.length, empty, withWork };

  /* index line health */
  const idxLines = L.readIndexLines(idxFile);
  const sess = idxLines.filter(l => l.startsWith('- S-'));
  const long = sess.filter(l => l.length > 250);
  r.index = {
    lines: idxLines.length,
    sessionLines: sess.length,
    longLines: long.length,
    longBytes: long.reduce((s, l) => s + Buffer.byteLength(l), 0)
  };
  if (r.index.longLines > 0) {
    r.warnings.push(`SESSIONS_INDEX carries ${r.index.longLines} paragraph-length lines (${kb(r.index.longBytes)} KB). The machine index should hold status, not prose — the prose already lives in the session file. Duplicated prose is the drift risk the charter warns about.`);
  }

  /* real pending work */
  r.pending = L.pendingWork(root, cfg, null);

  /* per-session fixed load */
  const rulesDir = path.join(root, '.claude', 'rules');
  let rb = 0, rn = 0, biggest = [];
  try {
    for (const f of fs.readdirSync(rulesDir)) {
      const s = fs.statSync(path.join(rulesDir, f));
      if (s.isFile()) { rb += s.size; rn++; biggest.push([f, s.size]); }
    }
  } catch (_) {}
  biggest.sort((a, b) => b[1] - a[1]);
  r.fixedLoad = { claudeMd: sizeOf(path.join(root, 'CLAUDE.md')), rulesBytes: rb, rulesFiles: rn, biggestRules: biggest.slice(0, 5) };

  /* eviction status (read-only) */
  r.evict = evict(root, cfg, true);

  /* integrity */
  try {
    const { computeIntegrity } = require('./validate.js');
    const v = computeIntegrity(root);
    r.integrity = { referenced: v.referenced.size, broken: v.broken.length, orphan: v.orphans.length, unindexed: v.unindexed.length, sizeWarn: v.sizeWarn };
    r.integrityDetail = { broken: v.broken.slice(0, 8), orphan: v.orphans.slice(0, 8), unindexed: v.unindexed.slice(0, 8) };
  } catch (e) { r.integrity = { error: e.message }; }

  return r;
}

function printReport(r, sid8) {
  const out = [];
  out.push('DS-ReCall wrap-prep — ' + r.root);
  out.push('');

  if (sid8) {
    const cfg = r.cfg;
    const sessionsAbs = L.safeJoin(r.root, cfg.sessionsDir, L.DEFAULTS.sessionsDir);
    const stub = L.findStubForSid(sessionsAbs, sid8);
    const info = stub ? L.readStubInfo(sessionsAbs, stub) : null;
    const line = L.readIndexLines(L.indexPath(r.root, cfg)).find(l => L.isSessionLine(l, sid8));
    const st = line && L.STATUS_RE.test(line) ? line.match(L.STATUS_RE)[1] : '(no index line)';
    out.push(`THIS SESSION  S-${sid8}`);
    out.push(`  stub        ${stub || '(none)'}${info ? '  · body ' + info.bodyChars + ' chars' : ''}`);
    out.push(`  index       ${st}`);
    out.push('');
  }

  out.push('WRAP READ SURFACE  (what the model would otherwise have to read)');
  let tb = 0;
  for (const s of r.surface) {
    tb += s.bytes;
    out.push(`  ${s.name.padEnd(16)} ${kb(s.bytes).padStart(7)} KB  ~${String(tok(s.bytes)).padStart(6)} tok${s.exists ? '' : '  (missing)'}`);
  }
  out.push(`  ${'TOTAL'.padEnd(16)} ${kb(tb).padStart(7)} KB  ~${String(tok(tb)).padStart(6)} tok   ← handled by this script, not by the model`);
  out.push('');

  out.push('STUBS');
  out.push(`  auto-stubs  ${r.stubs.total}   with work ${r.stubs.withWork}   empty ${r.stubs.empty}`);
  out.push('');

  out.push('PENDING WORK  (sessions with real content and no wrap)');
  if (r.pending.length === 0) out.push('  none — nothing is owed');
  else r.pending.slice(0, 15).forEach(p => out.push(`  S-${p.sid8}  ${String(p.bodyChars).padStart(6)} chars  ${p.file}`));
  if (r.pending.length > 15) out.push(`  … +${r.pending.length - 15} more`);
  out.push('');

  out.push('ROOT INDEX LINE CAP');
  out.push(`  ${r.evict.file}: ${r.evict.kept} session line(s) — ${r.evict.note}`);
  if (r.evict.moved.length) {
    out.push('  would evict (run with --evict):');
    r.evict.moved.forEach(m => out.push('    ' + m.slice(0, 110)));
  }
  out.push('');

  out.push('PER-SESSION FIXED LOAD  (paid on EVERY session, before any work)');
  out.push(`  CLAUDE.md        ${kb(r.fixedLoad.claudeMd).padStart(7)} KB  ~${tok(r.fixedLoad.claudeMd)} tok`);
  out.push(`  .claude/rules/   ${kb(r.fixedLoad.rulesBytes).padStart(7)} KB  ~${tok(r.fixedLoad.rulesBytes)} tok  (${r.fixedLoad.rulesFiles} files)`);
  out.push(`  TOTAL            ${kb(r.fixedLoad.claudeMd + r.fixedLoad.rulesBytes).padStart(7)} KB  ~${tok(r.fixedLoad.claudeMd + r.fixedLoad.rulesBytes)} tok`);
  r.fixedLoad.biggestRules.forEach(([f, s]) => out.push(`     ${kb(s).padStart(7)} KB  ${f}`));
  out.push('');

  out.push('INTEGRITY');
  if (r.integrity.error) out.push('  ERROR ' + r.integrity.error);
  else {
    out.push(`  referenced=${r.integrity.referenced}  broken=${r.integrity.broken}  orphan=${r.integrity.orphan}  unindexed=${r.integrity.unindexed}`);
    (r.integrityDetail.broken || []).forEach(b => out.push('  BROKEN    ' + b));
    (r.integrityDetail.orphan || []).forEach(o => out.push('  ORPHAN    ' + o));
    (r.integrityDetail.unindexed || []).forEach(u => out.push('  UNINDEXED ' + u));
    (r.integrity.sizeWarn || []).forEach(s => out.push('  SIZE      ' + s));
  }
  out.push('');

  if (r.warnings.length) {
    out.push('NOTES');
    r.warnings.forEach(w => out.push('  ⚠ ' + w));
    out.push('');
  }

  const fail = !r.integrity.error && (r.integrity.broken > 0 || r.integrity.orphan > 0 || r.integrity.unindexed > 0);
  out.push('RESULT: ' + (fail ? 'FAIL' : 'OK'));
  return { text: out.join('\n'), fail };
}

/* -------------------------------------------------------------------- main */

function main() {
  const argv = process.argv.slice(2);
  const root = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : (process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const cfg = L.loadConfig(root);

  /* --flip: change one status line without the model ever reading the index */
  if (argv.includes('--flip')) {
    const sid8 = String(argOf(argv, '--flip', '')).slice(0, 8);
    const statusName = String(argOf(argv, '--status', 'CONSOLIDATED')).toUpperCase();
    const status = L.STATUS[statusName];
    if (!sid8 || !status) { console.error('usage: --flip <sid8> --status OPEN|RAW|CONSOLIDATED|CLOSED'); process.exit(1); }
    const label = argOf(argv, '--label', '');
    const summary = argOf(argv, '--summary', '');
    const cap = Number(cfg.maxIndexLineChars || 0);
    let note = [label && `[${label}]`, summary].filter(Boolean).join(' · ');
    if (cap > 0 && note.length > cap) note = note.slice(0, cap - 1) + '…';
    const res = L.setIndexStatus(root, cfg, sid8, status, { note: note || undefined });
    console.log(`flip S-${sid8} → ${status}: ${res.action}`);
    if (res.line) console.log('  ' + res.line.slice(0, 200));
    process.exit(res.action === 'unchanged' ? 3 : 0);
  }

  /* --child-feed: append one row to the parent project's feed */
  if (argv.includes('--child-feed')) {
    const line = argOf(argv, '--child-feed', '');
    if (!line) { console.error('usage: --child-feed "<line>"'); process.exit(1); }
    const parent = L.findParentProject(root);
    if (!parent) { console.log('no parent project — nothing to feed'); process.exit(3); }
    const feed = path.join(parent, '.claude', 'CHILD_FEED.md');
    try {
      fs.mkdirSync(path.dirname(feed), { recursive: true });
      if (!fs.existsSync(feed)) fs.writeFileSync(feed, '# Child feed — sub-project session digests (append-only)\n\n');
      fs.appendFileSync(feed, (line.startsWith('- ') ? line : '- ' + line) + '\n');
      console.log('appended to ' + path.relative(root, feed));
      process.exit(0);
    } catch (e) { console.error('failed: ' + e.message); process.exit(1); }
  }

  /* --evict: enforce the root index line cap deterministically */
  if (argv.includes('--evict')) {
    const res = evict(root, cfg, argv.includes('--dry-run'));
    console.log(`evict ${res.file}: ${res.note}`);
    res.moved.forEach(m => console.log('  ' + m.slice(0, 140)));
    process.exit(res.ok ? (res.moved.length ? 0 : 3) : 1);
  }

  /* default: report (optionally with GC) */
  if (argv.includes('--gc')) {
    const gc = L.gcEmptyStubs(root, cfg);
    console.log(`GC: removed ${gc.removed.length} abandoned empty stub(s)  ·  scanned ${gc.scanned}, empty ${gc.empty}, kept-live ${gc.keptLive}, kept-recent ${gc.keptYoung}, with-work ${gc.keptWork}`);
    console.log('');
  }
  if (argv.includes('--rotate-backups')) {
    const rb = L.rotateBackups(root, cfg);
    console.log(`backups: gzipped ${rb.compressed.length}, deleted ${rb.deleted.length}, saved ${(rb.savedBytes / 1048576).toFixed(1)} MB, errors ${rb.errors}`);
    console.log('');
  }

  const sid = argOf(argv, '--session', process.env.CLAUDE_SESSION_ID || '');
  const r = build(root);
  if (argv.includes('--json')) { console.log(JSON.stringify(r, (k, v) => (v instanceof Set ? [...v] : v), 2)); process.exit(0); }
  const rep = printReport(r, sid ? L.sanitize(sid).slice(0, 8) : null);
  console.log(rep.text);
  process.exit(rep.fail ? 1 : 0);
}

module.exports = { build, printReport, evict };
if (require.main === module) main();
