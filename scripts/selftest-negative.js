#!/usr/bin/env node
/*
 * DS-ReCall — the test that tests the tests.
 *
 * A green suite proves nothing on its own. This harness injects a real defect into the
 * source, re-runs selftest.js, and asserts it goes RED — then restores the file byte-for-byte
 * and asserts it goes GREEN again. If a defect can be injected and the suite still passes,
 * that arm of the suite is decoration and is reported as BLIND.
 *
 * Every injection below corresponds to a guard that was written on purpose. If someone
 * removes one later, this file is what notices.
 *
 *   node selftest-negative.js
 *   exit 0 = every injected defect was caught · 1 = at least one arm is blind
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, 'session-lib.js');
const SUITE = path.join(__dirname, 'selftest.js');

const INJECTIONS = [
  {
    name: 'emptiness detector disabled',
    guards: 'the whole false-alarm fix — if every stub looks like work, v0.2 is v0.1 again',
    find: 'function isEmptyStub(content) { return stubBody(content).length <= 20; }',
    repl: 'function isEmptyStub(content) { return false; }'
  },
  {
    name: 'GC live-lock guard removed',
    guards: 'a stub belonging to a RUNNING session would be deleted under it',
    find: '    if (info.sid8 && live.has(info.sid8)) { res.keptLive++; continue; }',
    repl: '    if (false) { res.keptLive++; continue; }'
  },
  {
    name: 'GC age guard removed',
    guards: 'a stub created seconds ago would be collected before the session can write to it',
    find: '    if (info.mtime && info.mtime > cutoff) { res.keptYoung++; continue; }',
    repl: '    if (false) { res.keptYoung++; continue; }'
  },
  {
    name: 'auto-stub name pattern widened',
    guards: 'hand-written session notes must be out of GC scope — this is the file-loss guard',
    find: "const STUB_RE = /^(\\d{4}-\\d{2}-\\d{2})-([0-9a-zA-Z_-]{8})\\.md$/;",
    repl: "const STUB_RE = /^(\\d{4}-\\d{2}-\\d{2})[_-](.{1,40})\\.md$/;"
  },
  {
    name: 'status downgrade allowed',
    guards: 'CONSOLIDATED is terminal; without this a later hook silently reopens closed work',
    find: "    if (/✅\\s*CONSOLIDATED/.test(old)) return { action: 'unchanged', line: old };",
    repl: "    if (false) return { action: 'unchanged', line: old };"
  },
  {
    name: 'resume stub reuse removed',
    guards: 'resuming across days would spawn a second empty stub (58 ids hit this in the wild)',
    find: '      .filter(f => f.endsWith(\'-\' + sid8 + \'.md\'))',
    repl: '      .filter(f => false)'
  },
  {
    // First attempt at this injection was BLIND: it swapped a guard that made no difference
    // on a healthy run, so the suite stayed green. The guard is only real if the suite
    // exercises a run where compression FAILS. Now the injection deletes the transcript
    // BEFORE the compressed copy is safely on disk — the actual data-loss bug.
    name: 'transcript deleted before the compressed copy is verified',
    guards: 'verify-then-delete — a failed compression must never cost the original transcript',
    find: '        const gz = zlib.gzipSync(src, { level: 9 });',
    repl: '        const gz = zlib.gzipSync(src, { level: 9 }); fs.unlinkSync(p);'
  },
  {
    name: 'round-trip length verification removed',
    guards: 'a .gz that decompresses to the wrong length must not be accepted as a valid backup',
    find: "        if (back.length !== src.length) throw new Error('round-trip verify failed');",
    repl: '        void back;',
    // Declared BEFORE running, not after seeing the result — that distinction is the whole
    // difference between an honest limitation and quietly loosening a threshold.
    notExercisable:
      'zlib either throws on a corrupt buffer (already covered by the try/catch arm above) or '
      + 'returns the exact original. Producing "valid gzip, wrong length" needs a second, '
      + 'simultaneous defect in the compressor, and a single-defect injection cannot isolate '
      + 'this check. Kept as defence-in-depth for a future streaming refactor, where partial '
      + 'output IS reachable. Reported as NOT-EXERCISED rather than claimed as verified.'
  },
  {
    name: 'status resolved from the FIRST matching line only',
    guards: 'a legacy day-suffixed twin (⚪ CLOSED) must not mask the canonical ✅ CONSOLIDATED line',
    find: '  return sessionLinesFor(lines, sid8).some(l => /✅\\s*CONSOLIDATED/.test(l));',
    repl: '  const f = lines.find(l => isSessionLine(l, sid8)); return !!f && /✅\\s*CONSOLIDATED/.test(f);'
  },
  {
    name: 'path containment removed',
    guards: 'a copied config with ../../ must not become an arbitrary-write primitive',
    find: '  if (resolved === rootAbs || resolved.startsWith(rootAbs + path.sep)) return resolved;\n  return path.resolve(root, fallbackRel);',
    repl: '  return resolved;'
  }
];

function runSuite() {
  try { execFileSync(process.execPath, [SUITE], { encoding: 'utf8', stdio: 'pipe' }); return 0; }
  catch (e) { return e.status === undefined ? 99 : e.status; }
}

const original = fs.readFileSync(LIB, 'utf8');
const originalBytes = Buffer.byteLength(original);
// Anchors are written with \n. A Windows checkout (git autocrlf=true, the Git-for-Windows
// default) turns the working tree into CRLF, so any multi-line anchor silently stopped
// matching and the harness reported FAIL on a perfectly healthy install. Match the file's
// own line ending instead of assuming one. Restore stays byte-exact (we write `original`).
const EOL = original.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
const adapt = (s) => s.replace(/\r?\n/g, EOL);
let blind = 0, caught = 0, unapplied = 0, notExercised = 0;

console.log('DS-ReCall — negative test of the test suite');
console.log(`source: ${path.basename(LIB)} (${originalBytes} bytes)\n`);

console.log('baseline (unmodified source) …');
const base = runSuite();
console.log(`  exit ${base} — ${base === 0 ? 'GREEN as expected' : 'ALREADY RED, fix the suite before trusting this harness'}\n`);
if (base !== 0) { console.log('RESULT: ABORTED'); process.exit(1); }

for (const raw of INJECTIONS) {
  const inj = Object.assign({}, raw, { find: adapt(raw.find), repl: adapt(raw.repl) });
  if (original.indexOf(inj.find) === -1) {
    unapplied++;
    console.log(`? ${inj.name}`);
    console.log(`    anchor not found — injection could not be applied (source drifted?)`);
    continue;
  }
  fs.writeFileSync(LIB, original.replace(inj.find, inj.repl));
  const code = runSuite();
  fs.writeFileSync(LIB, original);                       // restore immediately, always
  const restored = fs.readFileSync(LIB, 'utf8') === original;
  if (!restored) { console.log('FATAL: could not restore source'); process.exit(1); }

  if (code !== 0) {
    caught++;
    console.log(`✓ ${inj.name}\n    caught (exit ${code}) — guards: ${inj.guards}`);
    if (inj.notExercisable) console.log(`    NOTE: was declared not-exercisable but the suite caught it — remove the declaration.`);
  } else if (inj.notExercisable) {
    notExercised++;
    console.log(`~ ${inj.name}\n    NOT EXERCISED (declared up-front) — guards: ${inj.guards}\n    reason: ${inj.notExercisable}`);
  } else {
    blind++;
    console.log(`✗ ${inj.name}\n    BLIND — suite stayed green with this defect present. Guards: ${inj.guards}`);
  }
}

console.log('\nconfirming restore …');
const finalCode = runSuite();
console.log(`  exit ${finalCode} — ${finalCode === 0 ? 'GREEN, source is intact' : 'RED after restore, investigate'}`);

const exercisable = INJECTIONS.length - notExercised;
console.log('\n' + '─'.repeat(72));
console.log(`INJECTIONS ${INJECTIONS.length}   CAUGHT ${caught}   BLIND ${blind}   NOT-EXERCISED ${notExercised}   NOT-APPLIED ${unapplied}`);
console.log(`coverage: ${caught}/${exercisable} exercisable defects made the suite fail`
  + (notExercised ? `  ·  ${notExercised} guard(s) declared not-exercisable and NOT claimed as verified` : ''));
const bad = blind > 0 || unapplied > 0 || finalCode !== 0;
console.log('RESULT: ' + (bad ? 'FAIL' : 'OK'));
process.exit(bad ? 1 : 0);
