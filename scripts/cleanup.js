#!/usr/bin/env node
/*
 * DS-ReCall — one-time backlog cleanup (archive → verify → remove)
 *
 * This exists to clear the debris v0.1 left behind. It is deliberately paranoid, because the
 * operator's single hard constraint was: do not damage the memory, and keep every key and
 * credential path intact.
 *
 * SAFETY MODEL — nothing is deleted until a verified copy exists:
 *   1. every candidate is COPIED into .claude/_arsiv/<date>-temizlik/ with a MANIFEST
 *   2. the copy is read back and byte-compared with the original
 *   3. only then is the original removed
 *   4. anything that fails any check is skipped and reported, never force-deleted
 *
 * HARD EXCLUSIONS (never touched, at any depth):
 *   any .env* · *token* · *secret* · *credential* · .pem/.key   (built-in)
 *   plus whatever `neverTouch` in ds-recall.config.json adds — put your vault/secret
 *   directory names there; the patterns are matched case-insensitively against the filename.
 *   Also never touched: any session file whose body is NOT empty, and every file outside
 *   the configured sessionsDir / backups directory.
 *
 * Transcript backups are COMPRESSED, never deleted (backupDeleteDays defaults to 0).
 *
 *   node cleanup.js <root> --dry-run     show exactly what would happen (default)
 *   node cleanup.js <root> --apply       do it
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./session-lib.js');

const root = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : process.cwd();
const APPLY = process.argv.includes('--apply');
const cfg = L.loadConfig(root);

// Built-in floor. Projects add their own vault/secret names via config `neverTouch`,
// so this file stays generic while each workspace keeps its own red lines.
const BUILTIN_NEVER = ['\\.env', 'token', 'secret', 'credential', '\\.pem$', '\\.key$'];
const NEVER = BUILTIN_NEVER.concat(Array.isArray(cfg.neverTouch) ? cfg.neverTouch : []);
const FORBIDDEN = new RegExp(NEVER.join('|'), 'i');

const stamp = L.nowLocal().slice(0, 10);
const arsiv = path.join(root, '.claude', '_arsiv', stamp + '-temizlik');
const log = [];
function say(s) { console.log(s); log.push(s); }

say('DS-ReCall cleanup — ' + (APPLY ? 'APPLY' : 'DRY-RUN (nothing will be changed)'));
say('root   : ' + root);
say('archive: ' + path.relative(root, arsiv));
say('');

/* ---------------------------------------------------- 1. empty session stubs */

const sessionsAbs = L.safeJoin(root, cfg.sessionsDir, '_sessions');
let names = [];
try { names = fs.readdirSync(sessionsAbs).filter(L.isAutoStubName); } catch (_) {}

const liveSids = new Set();
try {
  const cutoff = Date.now() - (cfg.staleLockHours || 12) * 3600 * 1000;
  for (const f of fs.readdirSync(path.join(root, '.claude', 'active'))) {
    if (!f.endsWith('.lock')) continue;
    let opened = 0;
    try { opened = Date.parse(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'active', f), 'utf8')).opened) || 0; } catch (_) {}
    if (opened >= cutoff) liveSids.add(f.replace(/\.lock$/, '').slice(0, 8));
  }
} catch (_) {}

const empties = [], keptWork = [], keptLive = [], refused = [];
for (const n of names) {
  if (FORBIDDEN.test(n)) { refused.push(n); continue; }
  const info = L.readStubInfo(sessionsAbs, n);
  if (!info) continue;
  if (!info.empty) { keptWork.push(n); continue; }
  if (info.sid8 && liveSids.has(info.sid8)) { keptLive.push(n); continue; }
  empties.push(info);
}
const emptyBytes = empties.reduce((s, e) => { try { return s + fs.statSync(e.abs).size; } catch (_) { return s; } }, 0);

say('1. EMPTY SESSION STUBS');
say(`   auto-stubs scanned : ${names.length}`);
say(`   have real content  : ${keptWork.length}   ← untouched`);
say(`   live session held  : ${keptLive.length}   ← untouched`);
say(`   name refused       : ${refused.length}`);
say(`   EMPTY → archive+rm : ${empties.length}  (${(emptyBytes / 1024).toFixed(1)} KB)`);
say('');

/* ------------------------------------------- 2. index lines for those stubs */

const idxFile = L.indexPath(root, cfg);
const idxBefore = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, 'utf8') : '';
const emptySids = new Set(empties.map(e => e.sid8).filter(Boolean));
// only drop a line when NO stub for that id survives, and the line is not CONSOLIDATED
const idxLines = idxBefore.split('\n');

// A machine-written line is exactly: "- S-<id> · <timestamp> · <status> · <path>".
// Anything longer carries a HUMAN annotation — a pointer to the real record, or an
// intention like "wrap'i kendi oturumunda yapılacak (Survival…)". Those are memory, not
// litter, and a cleanup must not swallow them just because the stub beside them is empty.
// Removing the file is safe (it is empty); removing someone's note is not.
function isMachineOnly(line) {
  const parts = line.split(' · ').map(s => s.trim()).filter(Boolean);
  if (parts.length > 4) return false;
  if (parts.length === 4 && !/\.md$/.test(parts[3])) return false;
  return true;
}

const dropIdx = [], keptAnnotated = [];
idxLines.forEach((l, i) => {
  if (!l.startsWith('- S-')) return;
  const m = l.match(/S-([0-9a-zA-Z_-]{8})/);
  if (!m || !emptySids.has(m[1])) return;
  if (/✅\s*CONSOLIDATED/.test(l)) return;                       // never drop a consolidated record
  const survivors = names.filter(n => n.endsWith('-' + m[1] + '.md') && !empties.find(e => e.file === n));
  if (survivors.length) return;                                  // another stub for this id lives on
  if (!isMachineOnly(l)) { keptAnnotated.push({ i, line: l }); return; } // human note → keep
  dropIdx.push(i);
});
say('2. SESSIONS_INDEX LINES belonging to those stubs');
say(`   file                : ${(Buffer.byteLength(idxBefore) / 1024).toFixed(1)} KB, ${idxLines.length} lines`);
say(`   removable (machine) : ${dropIdx.length}`);
say(`   KEPT (human note)   : ${keptAnnotated.length}   ← annotations are memory, never auto-removed`);
say(`   KEPT (consolidated) : always`);
if (keptAnnotated.length) {
  say('   examples of kept annotations:');
  keptAnnotated.slice(0, 3).forEach(x => say('     ' + x.line.slice(0, 120)));
  say('   → each gets an "📦 arşivlendi" marker so the line stops pointing at a file that moved');
}
say('');

/* -------------------------------------------------- 3. transcript backups */

const bdir = path.join(root, '.claude', 'backups');
let bFiles = [];
try { bFiles = fs.readdirSync(bdir).filter(f => f.endsWith('.jsonl')); } catch (_) {}
const cDays = Number(cfg.backupCompressDays || 14);
const old = bFiles.filter(f => {
  try { return (Date.now() - fs.statSync(path.join(bdir, f)).mtimeMs) / 86400000 > cDays; } catch (_) { return false; }
});
const oldBytes = old.reduce((s, f) => { try { return s + fs.statSync(path.join(bdir, f)).size; } catch (_) { return s; } }, 0);
const allBytes = bFiles.reduce((s, f) => { try { return s + fs.statSync(path.join(bdir, f)).size; } catch (_) { return s; } }, 0);
say('3. TRANSCRIPT BACKUPS  (compressed in place — NEVER deleted)');
say(`   .jsonl files    : ${bFiles.length}  (${(allBytes / 1048576).toFixed(1)} MB)`);
say(`   older than ${cDays}d  : ${old.length}  (${(oldBytes / 1048576).toFixed(1)} MB) → gzip`);
say('');

/* -------------------------------------------------------------- 4. apply */

if (!APPLY) {
  say('DRY-RUN complete. Re-run with --apply to execute.');
  process.exit(0);
}

fs.mkdirSync(path.join(arsiv, 'stubs'), { recursive: true });

// 4a. archive + verify + remove the empty stubs
let moved = 0, failed = 0;
for (const e of empties) {
  try {
    const src = fs.readFileSync(e.abs);
    const dst = path.join(arsiv, 'stubs', e.file);
    fs.writeFileSync(dst, src);
    const back = fs.readFileSync(dst);
    if (back.length !== src.length || !back.equals(src)) { failed++; continue; }  // verify BEFORE removing
    fs.unlinkSync(e.abs);
    moved++;
  } catch (_) { failed++; }
}
say(`4a. stubs archived+removed: ${moved}   failed(kept): ${failed}`);

// 4b. archive the index, then remove the orphaned lines
try {
  fs.writeFileSync(path.join(arsiv, 'SESSIONS_INDEX.before.md'), idxBefore);
  const back = fs.readFileSync(path.join(arsiv, 'SESSIONS_INDEX.before.md'), 'utf8');
  if (back === idxBefore) {
    const MARK = ' · 📦 arşivlendi 2026-08-07 (.claude/_arsiv/' + stamp + '-temizlik/stubs/)';
    const work = idxLines.slice();
    // annotated lines survive, but must stay truthful: their stub file no longer sits where
    // the line says it does. An index that points at a moved file is the drift the whole
    // product exists to prevent.
    for (const x of keptAnnotated) if (work[x.i].indexOf('📦 arşivlendi') === -1) work[x.i] = work[x.i] + MARK;
    const keep = work.filter((_, i) => dropIdx.indexOf(i) === -1);
    fs.writeFileSync(idxFile, keep.join('\n'));
    say(`4b. index: ${dropIdx.length} machine line(s) removed, ${keptAnnotated.length} annotated line(s) kept+marked  (${(Buffer.byteLength(idxBefore) / 1024).toFixed(1)} → ${(Buffer.byteLength(keep.join('\n')) / 1024).toFixed(1)} KB)`);
  } else {
    say('4b. index: archive verification FAILED — index left untouched');
  }
} catch (e) { say('4b. index: ERROR ' + e.message + ' — index left untouched'); }

// 4c. compress old transcripts (lossless; rotateBackups verifies round-trip before unlinking)
const cfg2 = Object.assign({}, cfg, { backupCompressPerRun: 999, backupDeleteDays: 0 });
const rb = L.rotateBackups(root, cfg2);
say(`4c. backups: gzipped ${rb.compressed.length}, errors ${rb.errors}, saved ${(rb.savedBytes / 1048576).toFixed(1)} MB, deleted ${rb.deleted.length} (must be 0)`);

// 4d. manifest — so nothing is ever "just gone"
const manifest = [
  '# DS-ReCall cleanup manifest — ' + L.nowLocal(),
  '',
  'This folder holds a VERIFIED copy of every file whose original was removed by this run.',
  'Each file was copied here first, compared byte-for-byte, and only then deleted from its',
  'original location. To restore: copy files from stubs/ back into ' + cfg.sessionsDir + '/.',
  '',
  '## Removed empty session stubs (' + moved + ' files, ' + (emptyBytes / 1024).toFixed(1) + ' KB)',
  'Every one had an EMPTY body (<=20 chars beyond the template). No file containing work was',
  'touched — ' + keptWork.length + ' session records with real content were left in place.',
  '',
  ...empties.slice(0, 400).map(e => '- ' + e.file),
  '',
  '## SESSIONS_INDEX',
  '- SESSIONS_INDEX.before.md = full copy taken before any edit',
  '- lines removed: ' + dropIdx.length + '  (pure machine-format lines only)',
  '- lines KEPT: every ✅ CONSOLIDATED line, plus ' + keptAnnotated.length + ' lines carrying a human note',
  '',
  '## Transcript backups',
  '- ' + rb.compressed.length + ' file(s) gzipped — LOSSLESS, fully restorable',
  '- deleted: ' + rb.deleted.length + ' (should be 0)',
  '- restore one:  node -e "require(\'fs\').writeFileSync(\'x.jsonl\', require(\'zlib\').gunzipSync(require(\'fs\').readFileSync(\'x.jsonl.gz\')))"',
  '',
  '## NEVER TOUCHED',
  '- files matching: ' + NEVER.join(' | '),
  '- ' + keptWork.length + ' session records that contain work',
  '- everything outside ' + cfg.sessionsDir + '/ and .claude/backups/',
  ''
].join('\n');
fs.writeFileSync(path.join(arsiv, 'MANIFEST.md'), manifest);
fs.writeFileSync(path.join(arsiv, 'cleanup.log'), log.join('\n'));

say('');
say('4d. manifest written: ' + path.relative(root, path.join(arsiv, 'MANIFEST.md')));
say('DONE.');
