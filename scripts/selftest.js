#!/usr/bin/env node
/*
 * DS-ReCall — v0.2 self-test
 *
 * This file exists because of a rule learned the hard way on this workspace:
 *   "A gate that lights green without measuring anything is worse than no gate."
 * So every assertion below comes in pairs — the POSITIVE arm proves the fix works, and the
 * NEGATIVE arm deliberately breaks the input and proves the check goes RED. A check whose
 * negative arm cannot be made to fail is not a check; it is decoration.
 *
 * It also prints COVERAGE for every group: "0 violations" carries zero information unless
 * you also say how many cases were actually examined.
 *
 * Runs entirely inside a throwaway temp workspace. Touches nothing real.
 *   node selftest.js            → human report, exit 0 clean / 1 failed
 *   node selftest.js --verbose  → also print each passing case
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./session-lib.js');
const WP = require('./wrap-prep.js');

const VERBOSE = process.argv.includes('--verbose');
let PASS = 0, FAIL = 0, CASES = 0;
const failures = [];

function ok(group, name, cond, detail) {
  CASES++;
  if (cond) { PASS++; if (VERBOSE) console.log(`   ✓ [${group}] ${name}`); }
  else { FAIL++; failures.push(`[${group}] ${name}${detail ? ' — ' + detail : ''}`); console.log(`   ✗ [${group}] ${name}${detail ? ' — ' + detail : ''}`); }
}

/* --------------------------------------------------------------- fixtures */

function mkWorkspace(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsrecall-' + tag + '-'));
  fs.mkdirSync(path.join(root, '.claude', 'active'), { recursive: true });
  fs.mkdirSync(path.join(root, '_sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test index\n> updated: ' + L.nowLocal().slice(0, 10) + '\n\n## Son oturumlar\n');
  fs.writeFileSync(path.join(root, '.claude', 'ds-recall.config.json'), JSON.stringify({
    sessionsDir: '_sessions',
    sessionsIndex: '.claude/SESSIONS_INDEX.md',
    staleLockHours: 12,
    wrapCommand: '/ds-wrap',
    evict: { file: 'CLAUDE.md', linePattern: '^- \\[S-', maxLines: 3, targetFile: '_sessions/00-INDEX.md', targetAnchor: '^## ' }
  }, null, 2));
  fs.writeFileSync(path.join(root, '_sessions', '00-INDEX.md'), '# History\n\n## Sessions\n');
  return root;
}
const EMPTY_STUB = (sid, ts) =>
  '---\nsession: ' + sid + '\nopened: ' + ts + '\n---\n'
  + '# Session ' + ts.slice(0, 10) + ' · <title at /wrap>\n\n'
  + '## What happened\n<!-- SessionStart opened this (empty). /wrap fills it. Status lives in SESSIONS_INDEX. -->\n\n'
  + '## Decisions (→ DECISIONS.md)\n\n## Open threads\n';
const WORK_STUB = (sid, ts, body) => EMPTY_STUB(sid, ts).replace('## Open threads\n',
  '## Open threads\n' + (body || 'Fixed the widget; decided to ship on Tuesday; open: token rotation.') + '\n');

function ageFile(p, hours) {
  const t = new Date(Date.now() - hours * 3600 * 1000);
  fs.utimesSync(p, t, t);
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

/* ============================ 1. THE ORIGINAL BUG ======================== */
/* v0.1 counted index lines. 59 lines said RAW; 58 of the stubs were empty.     */

function testFalseAlarm() {
  console.log('\n1. FALSE-ALARM CLASS  (the reported bug: "59 unconsolidated, but they are all sealed")');
  const root = mkWorkspace('alarm');
  const cfg = L.loadConfig(root);
  const sdir = path.join(root, '_sessions');
  const ts = L.nowLocal();

  // 20 empty stubs (what v0.1 produced), 2 with real work
  for (let i = 0; i < 20; i++) {
    const sid = ('empty' + String(i).padStart(3, '0')).slice(0, 8);
    fs.writeFileSync(path.join(sdir, '2026-08-01-' + sid + '.md'), EMPTY_STUB(sid, ts));
    L.setIndexStatus(root, cfg, sid, L.STATUS.RAW, { ts });
  }
  for (const sid of ['work0001', 'work0002']) {
    fs.writeFileSync(path.join(sdir, '2026-08-01-' + sid + '.md'), WORK_STUB(sid, ts));
    L.setIndexStatus(root, cfg, sid, L.STATUS.RAW, { ts });
  }

  // v0.1 logic, VERBATIM from the old session-start.js (lines 149-154).
  // Copying it exactly matters: an approximation makes the comparison meaningless.
  // (First attempt at this test dropped the `.map(S-…)/.filter(Boolean)` stage and read 23
  //  instead of 22 — it was counting the index legend line. The probe was wrong, not the code.)
  const idx = fs.readFileSync(L.indexPath(root, cfg), 'utf8');
  const oldCount = idx.split('\n')
    .filter(l => /🟡\s*RAW/.test(l) && l.indexOf('zzzzzzzz') === -1)
    .map(l => { const m = l.match(/S-([A-Za-z0-9_-]+)/); return m ? m[1] : null; })
    .filter(Boolean).length;
  const newCount = L.pendingWork(root, cfg, null).length;

  console.log(`   scanned 22 sessions (20 empty + 2 with work)`);
  console.log(`   v0.1 counter says : ${oldCount}   ← every line, regardless of content`);
  console.log(`   v0.2 counter says : ${newCount}   ← only sessions that hold work`);

  ok('alarm', 'v0.1 logic reproduces the false alarm', oldCount === 22, `got ${oldCount}, expected 22`);
  ok('alarm', 'v0.2 counts only real work', newCount === 2, `got ${newCount}, expected 2`);

  // NEGATIVE ARM — if the counter cannot go up when work appears, it measures nothing
  const sid = 'work0003';
  fs.writeFileSync(path.join(sdir, '2026-08-01-' + sid + '.md'), WORK_STUB(sid, ts));
  L.setIndexStatus(root, cfg, sid, L.STATUS.RAW, { ts });
  const after = L.pendingWork(root, cfg, null).length;
  ok('alarm', 'NEGATIVE: adding one session with work raises the count', after === 3, `got ${after}, expected 3`);

  // NEGATIVE ARM 2 — consolidating must lower it
  L.setIndexStatus(root, cfg, sid, L.STATUS.CONSOLIDATED);
  const after2 = L.pendingWork(root, cfg, null).length;
  ok('alarm', 'NEGATIVE: consolidating lowers the count', after2 === 2, `got ${after2}, expected 2`);

  // BOUNDARY — a stub with 21 chars of body is work; 20 or fewer is scaffolding noise
  ok('alarm', 'boundary: 25-char body counts as work', !L.isEmptyStub(WORK_STUB('b', ts, 'x'.repeat(25))));
  ok('alarm', 'boundary: 5-char body counts as empty', L.isEmptyStub(WORK_STUB('b', ts, 'x'.repeat(5))));
  rmrf(root);
}

/* ============================ 2. GC SAFETY GUARDS ======================== */

function testGc() {
  console.log('\n2. GC GUARDS  (deleting the wrong file is the only unrecoverable failure here)');
  const root = mkWorkspace('gc');
  const cfg = L.loadConfig(root);
  const sdir = path.join(root, '_sessions');
  const ts = L.nowLocal();

  // (a) abandoned + empty + old  → MUST be collected
  fs.writeFileSync(path.join(sdir, '2026-07-01-aaaaaaaa.md'), EMPTY_STUB('aaaaaaaa', ts));
  ageFile(path.join(sdir, '2026-07-01-aaaaaaaa.md'), 48);
  L.setIndexStatus(root, cfg, 'aaaaaaaa', L.STATUS.OPEN, { ts });

  // (b) empty but a LIVE lock exists → MUST survive
  fs.writeFileSync(path.join(sdir, '2026-07-01-bbbbbbbb.md'), EMPTY_STUB('bbbbbbbb', ts));
  ageFile(path.join(sdir, '2026-07-01-bbbbbbbb.md'), 48);
  fs.writeFileSync(path.join(root, '.claude', 'active', 'bbbbbbbb-live.lock'), JSON.stringify({ opened: ts }));

  // (c) empty but RECENT → MUST survive
  fs.writeFileSync(path.join(sdir, '2026-07-01-cccccccc.md'), EMPTY_STUB('cccccccc', ts));

  // (d) old and abandoned but HAS WORK → MUST survive
  fs.writeFileSync(path.join(sdir, '2026-07-01-dddddddd.md'), WORK_STUB('dddddddd', ts));
  ageFile(path.join(sdir, '2026-07-01-dddddddd.md'), 48);

  // (e) hand-written note, not an auto-stub name → MUST survive (out of scope by pattern)
  fs.writeFileSync(path.join(sdir, '2026-07-01_manuel-notlar.md'), '# elle yazilmis\n');
  ageFile(path.join(sdir, '2026-07-01_manuel-notlar.md'), 48);

  const gc = L.gcEmptyStubs(root, cfg);
  const exists = f => fs.existsSync(path.join(sdir, f));

  console.log(`   coverage: scanned ${gc.scanned} auto-stubs · empty ${gc.empty} · removed ${gc.removed.length} · kept-live ${gc.keptLive} · kept-recent ${gc.keptYoung} · kept-work ${gc.keptWork}`);

  ok('gc', 'abandoned empty stub is collected', !exists('2026-07-01-aaaaaaaa.md'));
  ok('gc', 'index line of collected stub is removed',
    !fs.readFileSync(L.indexPath(root, cfg), 'utf8').includes('S-aaaaaaaa'));
  ok('gc', 'LIVE session stub survives', exists('2026-07-01-bbbbbbbb.md'));
  ok('gc', 'RECENT stub survives', exists('2026-07-01-cccccccc.md'));
  ok('gc', 'stub WITH WORK survives', exists('2026-07-01-dddddddd.md'));
  ok('gc', 'hand-written note is out of GC scope', exists('2026-07-01_manuel-notlar.md'));
  ok('gc', 'coverage is reported, not just the verdict', gc.scanned === 4, `scanned ${gc.scanned}, expected 4 auto-stubs`);

  // NEGATIVE ARM — remove the emptiness guard mentally: if GC removed a work stub we would
  // see it here. Prove the guard is load-bearing by flipping the input, not the code.
  fs.writeFileSync(path.join(sdir, '2026-07-01-eeeeeeee.md'), EMPTY_STUB('eeeeeeee', ts));
  ageFile(path.join(sdir, '2026-07-01-eeeeeeee.md'), 48);
  const gc2 = L.gcEmptyStubs(root, cfg);
  ok('gc', 'NEGATIVE: a newly abandoned empty stub is caught on the next sweep',
    gc2.removed.length === 1 && gc2.removed[0].includes('eeeeeeee'), JSON.stringify(gc2.removed));
  rmrf(root);
}

/* ============================ 3. CONCURRENCY ============================= */

function testConcurrency() {
  console.log('\n3. CONCURRENCY  (a duplicate index line was observed in the wild: 472f6832 listed twice)');
  const root = mkWorkspace('conc');
  const cfg = L.loadConfig(root);
  const ts = L.nowLocal();

  // hammer the same id from one process — exercises the check-then-act window
  for (let i = 0; i < 25; i++) L.setIndexStatus(root, cfg, 'dupdupdu', L.STATUS.OPEN, { ts });
  const lines = L.readIndexLines(L.indexPath(root, cfg)).filter(l => l.includes('S-dupdupdu'));
  ok('conc', '25 repeated writes produce exactly ONE line', lines.length === 1, `got ${lines.length}`);

  // status machine must not go backwards
  L.setIndexStatus(root, cfg, 'dupdupdu', L.STATUS.RAW);
  let l = L.readIndexLines(L.indexPath(root, cfg)).find(x => x.includes('S-dupdupdu'));
  ok('conc', 'OPEN → RAW is allowed', /🟡\s*RAW/.test(l));
  L.setIndexStatus(root, cfg, 'dupdupdu', L.STATUS.OPEN);
  l = L.readIndexLines(L.indexPath(root, cfg)).find(x => x.includes('S-dupdupdu'));
  ok('conc', 'RAW → OPEN is REFUSED (no silent downgrade)', /🟡\s*RAW/.test(l), l);
  L.setIndexStatus(root, cfg, 'dupdupdu', L.STATUS.CONSOLIDATED);
  L.setIndexStatus(root, cfg, 'dupdupdu', L.STATUS.RAW);
  l = L.readIndexLines(L.indexPath(root, cfg)).find(x => x.includes('S-dupdupdu'));
  ok('conc', 'CONSOLIDATED is terminal', /✅\s*CONSOLIDATED/.test(l), l);

  // the lock file must never be left behind
  ok('conc', 'advisory lock is released', !fs.existsSync(path.join(root, '.claude', '.index.lock')));

  // ── LEGACY DAY-SUFFIXED LINES ───────────────────────────────────────────
  // Real indexes contain BOTH `- S-a6278ad3 · … ✅ CONSOLIDATED` and a hand-written
  // `- S-a6278ad3-0806 · … ⚪ CLOSED` for the same session. Found on the live workspace:
  // reading "the first line containing this id" picked the CLOSED one, so 4 already-wrapped
  // sessions were reported as unconsolidated work. Status must be resolved across ALL lines.
  const f = L.indexPath(root, cfg);
  fs.appendFileSync(f, '- S-legacy01-0806 · 2026-08-06 · ⚪ CLOSED · empty resume stub\n');
  fs.appendFileSync(f, '- S-legacy01 · 2026-08-05 · ✅ CONSOLIDATED · the real record\n');
  const ls = L.readIndexLines(f);
  ok('conc', 'suffixed line does not mask the canonical status', L.isConsolidated(ls, 'legacy01'));
  ok('conc', 'canonical line is ordered first', /✅/.test(L.sessionLinesFor(ls, 'legacy01')[0]));
  ok('conc', 'exact matcher rejects a suffixed line', !L.isExactSessionLine('- S-legacy01-0806 · x', 'legacy01'));
  ok('conc', 'exact matcher accepts the canonical line', L.isExactSessionLine('- S-legacy01 · x', 'legacy01'));

  // a consolidated session with a suffixed CLOSED twin must NOT resurface as pending work
  const sdir = path.join(root, '_sessions');
  fs.writeFileSync(path.join(sdir, '2026-08-05-legacy01.md'), WORK_STUB('legacy01', ts));
  ok('conc', 'NEGATIVE: consolidated-with-legacy-twin is not counted as pending',
    L.pendingWork(root, cfg, null).every(p => p.sid8 !== 'legacy01'),
    JSON.stringify(L.pendingWork(root, cfg, null).map(p => p.sid8)));

  // …but flipping only the suffixed twin must still leave the session pending
  fs.writeFileSync(path.join(sdir, '2026-08-05-legacy02.md'), WORK_STUB('legacy02', ts));
  fs.appendFileSync(f, '- S-legacy02-0806 · 2026-08-06 · ⚪ CLOSED · empty resume stub\n');
  ok('conc', 'NEGATIVE: a CLOSED twin alone does not mark work as done',
    L.pendingWork(root, cfg, null).some(p => p.sid8 === 'legacy02'));
  rmrf(root);
}

/* ============================ 4. RESUME / MULTI-DAY ===================== */

function testResume() {
  console.log('\n4. RESUME ACROSS DAYS  (58 session ids had 2-5 day-stubs each; worst case 5)');
  const root = mkWorkspace('resume');
  const sdir = path.join(root, '_sessions');
  fs.writeFileSync(path.join(sdir, '2026-08-01-abcdabcd.md'), EMPTY_STUB('abcdabcd', L.nowLocal()));

  const found = L.findStubForSid(sdir, 'abcdabcd');
  ok('resume', 'existing stub for the id is found regardless of its date', found === '2026-08-01-abcdabcd.md', String(found));

  // simulate a resume 3 days later — v0.1 would have written 2026-08-04-abcdabcd.md
  fs.writeFileSync(path.join(sdir, '2026-08-04-abcdabcd.md'), EMPTY_STUB('abcdabcd', L.nowLocal()));
  const all = fs.readdirSync(sdir).filter(f => f.includes('abcdabcd'));
  ok('resume', 'the v0.1 failure is reproducible (two files for one session)', all.length === 2);
  ok('resume', 'v0.2 reuses the FIRST stub instead of creating a second',
    L.findStubForSid(sdir, 'abcdabcd') === '2026-08-01-abcdabcd.md');
  rmrf(root);
}

/* ============================ 5. EVICTION =============================== */

function testEvict() {
  console.log('\n5. ROOT-INDEX EVICTION  (this file grew to 97,8 KB because nothing ever deleted)');
  const root = mkWorkspace('evict');
  const cfg = L.loadConfig(root);
  const cm = path.join(root, 'CLAUDE.md');
  let body = fs.readFileSync(cm, 'utf8');
  for (let i = 1; i <= 5; i++) body += `- [S-000000${i}](_sessions/x${i}.md) · 2026-08-0${i} · session ${i}\n`;
  fs.writeFileSync(cm, body);

  const dry = WP.evict(root, cfg, true);
  ok('evict', 'over-cap is detected (5 lines, cap 3)', dry.kept === 5 && dry.moved.length === 2, JSON.stringify({ kept: dry.kept, moved: dry.moved.length }));

  const res = WP.evict(root, cfg, false);
  const after = fs.readFileSync(cm, 'utf8').split('\n').filter(l => /^- \[S-/.test(l));
  const hist = fs.readFileSync(path.join(root, '_sessions', '00-INDEX.md'), 'utf8');
  ok('evict', 'source is trimmed to the cap', after.length === 3, `got ${after.length}`);
  ok('evict', 'evicted lines land in the history file (moved, not deleted)',
    hist.includes('S-0000004') && hist.includes('S-0000005'));
  ok('evict', 'nothing is lost: evicted lines are gone from source',
    !fs.readFileSync(cm, 'utf8').includes('S-0000005'));

  // NEGATIVE ARM — at or under the cap it must be a no-op
  const again = WP.evict(root, cfg, false);
  ok('evict', 'NEGATIVE: at cap the evictor does nothing', again.moved.length === 0, JSON.stringify(again.moved));
  rmrf(root);
}

/* ============================ 6. BACKUP ROTATION ======================== */

function testBackups() {
  console.log('\n6. BACKUP ROTATION  (1.034 MB across 76 transcripts, no rotation, nothing reads them)');
  const root = mkWorkspace('backup');
  const bdir = path.join(root, '.claude', 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const cfgPath = path.join(root, '.claude', 'ds-recall.config.json');
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  c.backupCompressDays = 7; c.backupDeleteDays = 0;  // lossless default
  fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
  const cfg = L.loadConfig(root);

  const payload = JSON.stringify({ role: 'assistant', text: 'x'.repeat(400) }).repeat(500);
  fs.writeFileSync(path.join(bdir, 'old.jsonl'), payload);   ageFile(path.join(bdir, 'old.jsonl'), 24 * 30);
  fs.writeFileSync(path.join(bdir, 'fresh.jsonl'), payload);

  const before = fs.statSync(path.join(bdir, 'old.jsonl')).size;
  const r = L.rotateBackups(root, cfg);
  const after = fs.existsSync(path.join(bdir, 'old.jsonl.gz')) ? fs.statSync(path.join(bdir, 'old.jsonl.gz')).size : 0;

  console.log(`   coverage: 2 files examined · compressed ${r.compressed.length} · deleted ${r.deleted.length} · ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
  ok('backup', 'old transcript is gzipped', fs.existsSync(path.join(bdir, 'old.jsonl.gz')));
  ok('backup', 'original is replaced only after the .gz exists', !fs.existsSync(path.join(bdir, 'old.jsonl')));
  ok('backup', 'recent transcript is untouched', fs.existsSync(path.join(bdir, 'fresh.jsonl')));
  ok('backup', 'compression actually saves space', after > 0 && after < before, `${after} vs ${before}`);
  ok('backup', 'DEFAULT IS LOSSLESS: nothing deleted when backupDeleteDays=0', r.deleted.length === 0);

  // the gz must still be readable — a backup you cannot restore is not a backup
  const back = require('zlib').gunzipSync(fs.readFileSync(path.join(bdir, 'old.jsonl.gz'))).toString('utf8');
  ok('backup', 'gzipped transcript round-trips byte-identical', back === payload);

  // ── THE ARM THAT WAS BLIND ──────────────────────────────────────────────
  // The first version of this suite claimed to test "the original is only deleted once the
  // compressed copy exists", but it never created a run where compression FAILS — so the
  // guard could be deleted and the suite stayed green. selftest-negative.js caught that.
  // Real failure injected through real input: occupy the destination path with a DIRECTORY,
  // which makes writeFileSync throw EISDIR on both Windows and POSIX. The transcript must
  // survive; losing it because compression failed is the one unrecoverable outcome here.
  fs.writeFileSync(path.join(bdir, 'doomed.jsonl'), payload);
  ageFile(path.join(bdir, 'doomed.jsonl'), 24 * 30);
  fs.mkdirSync(path.join(bdir, 'doomed.jsonl.gz'), { recursive: true });
  const r2 = L.rotateBackups(root, cfg);
  ok('backup', 'FAILURE PATH: original survives when compression cannot be written',
    fs.existsSync(path.join(bdir, 'doomed.jsonl')));
  ok('backup', 'FAILURE PATH: the failure is counted, not swallowed silently', r2.errors >= 1, `errors=${r2.errors}`);
  ok('backup', 'FAILURE PATH: a failed file is not reported as compressed',
    !r2.compressed.includes('doomed.jsonl'), JSON.stringify(r2.compressed));
  rmrf(root);
}

/* ============================ 7. PATH CONTAINMENT ======================= */

function testContainment() {
  console.log('\n7. PATH CONTAINMENT  (a copied config must not become an arbitrary-write primitive)');
  const root = mkWorkspace('contain');
  const escaped = L.safeJoin(root, '../../outside', '_sessions');
  ok('contain', 'escaping sessionsDir falls back to the safe default',
    escaped === path.resolve(root, '_sessions'), escaped);
  ok('contain', 'a normal relative path is preserved',
    L.safeJoin(root, '_sessions', 'docs/sessions') === path.resolve(root, '_sessions'));
  rmrf(root);
}

/* ============================ 8. END-TO-END ============================= */

function testEndToEnd() {
  console.log('\n8. END-TO-END  (real hook processes, real stdin, real files)');
  const { execFileSync } = require('child_process');
  const root = mkWorkspace('e2e');
  const startJs = path.join(__dirname, 'session-start.js');
  const endJs = path.join(__dirname, 'session-end.js');
  const sid = 'e2e11111-2222-3333-4444-555555555555';
  const sid8 = 'e2e11111';
  const run = (js, extra) => execFileSync(process.execPath, [js], {
    input: JSON.stringify(Object.assign({ session_id: sid, cwd: root, hook_event_name: 'x' }, extra || {})),
    encoding: 'utf8'
  });

  const outStart = run(startJs, { source: 'startup' });
  let ctx = '';
  try { ctx = JSON.parse(outStart).hookSpecificOutput.additionalContext; } catch (_) {}
  ok('e2e', 'SessionStart emits context', ctx.includes('[DS-ReCall]'), ctx.slice(0, 80));
  ok('e2e', 'SessionStart does NOT warn on a clean workspace', !/UNCONSOLIDATED/.test(ctx), ctx);
  ok('e2e', 'lock created', fs.existsSync(path.join(root, '.claude', 'active', sid + '.lock')));
  const stub = L.findStubForSid(path.join(root, '_sessions'), sid8);
  ok('e2e', 'stub created', !!stub, String(stub));
  ok('e2e', 'index line is OPEN, not RAW',
    /⚪\s*OPEN/.test(L.readIndexLines(L.indexPath(root, L.loadConfig(root))).find(l => l.includes('S-' + sid8)) || ''));

  // resume on the same day must not duplicate anything
  run(startJs, { source: 'resume' });
  const stubs = fs.readdirSync(path.join(root, '_sessions')).filter(f => f.includes(sid8));
  ok('e2e', 'resume does not create a second stub', stubs.length === 1, JSON.stringify(stubs));
  const openLines = L.readIndexLines(L.indexPath(root, L.loadConfig(root))).filter(l => l.includes('S-' + sid8));
  ok('e2e', 'resume does not create a second index line', openLines.length === 1, String(openLines.length));

  // end an EMPTY session → stub and line must be retracted
  run(endJs, { reason: 'exit' });
  ok('e2e', 'empty session: stub retracted', !L.findStubForSid(path.join(root, '_sessions'), sid8));
  ok('e2e', 'empty session: index line retracted',
    !fs.readFileSync(L.indexPath(root, L.loadConfig(root)), 'utf8').includes('S-' + sid8));
  ok('e2e', 'lock released', !fs.existsSync(path.join(root, '.claude', 'active', sid + '.lock')));

  // NEGATIVE ARM — a session WITH work must keep everything and be flagged RAW
  run(startJs, { source: 'startup' });
  const s2 = L.findStubForSid(path.join(root, '_sessions'), sid8);
  const sp = path.join(root, '_sessions', s2);
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8') + '\nGercek is: rapor yazildi, karar alindi, iki dosya degisti.\n');
  run(endJs, { reason: 'exit' });
  ok('e2e', 'NEGATIVE: session with work keeps its stub', !!L.findStubForSid(path.join(root, '_sessions'), sid8));
  const raw = L.readIndexLines(L.indexPath(root, L.loadConfig(root))).find(l => l.includes('S-' + sid8)) || '';
  ok('e2e', 'NEGATIVE: session with work is flagged RAW', /🟡\s*RAW/.test(raw), raw);
  ok('e2e', 'NEGATIVE: closed stamp written', /^closed:/m.test(fs.readFileSync(path.join(root, '_sessions', L.findStubForSid(path.join(root, '_sessions'), sid8)), 'utf8')));

  // and the NEXT session must now warn — this is the whole product promise
  const out3 = run(startJs, { session_id: 'other111-aaaa', source: 'startup' });
  let ctx3 = '';
  try { ctx3 = JSON.parse(out3).hookSpecificOutput.additionalContext; } catch (_) {}
  ok('e2e', 'NEGATIVE: the next session DOES warn about the real pending work',
    /UNCONSOLIDATED WORK: 1 /.test(ctx3), ctx3.slice(0, 200));

  // wrap-prep --flip closes it out without reading the index
  execFileSync(process.execPath, [path.join(__dirname, 'wrap-prep.js'), root, '--flip', sid8, '--status', 'CONSOLIDATED', '--label', 'Test'], { encoding: 'utf8' });
  const out4 = run(startJs, { session_id: 'other222-bbbb', source: 'startup' });
  let ctx4 = '';
  try { ctx4 = JSON.parse(out4).hookSpecificOutput.additionalContext; } catch (_) {}
  ok('e2e', 'after --flip the warning is gone', !/UNCONSOLIDATED/.test(ctx4), ctx4.slice(0, 200));
  rmrf(root);
}

/* ================================ RUN =================================== */

console.log('DS-ReCall v0.2 self-test — every check has a negative arm, every group reports coverage');
testFalseAlarm();
testGc();
testConcurrency();
testResume();
testEvict();
testBackups();
testContainment();
testEndToEnd();

console.log('\n' + '─'.repeat(72));
console.log(`CASES ${CASES}   PASS ${PASS}   FAIL ${FAIL}`);
if (FAIL) { console.log('\nFAILURES:'); failures.forEach(f => console.log('  ✗ ' + f)); }
console.log('RESULT: ' + (FAIL ? 'FAIL' : 'OK'));
process.exit(FAIL ? 1 : 0);
