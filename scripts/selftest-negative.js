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
  },

  /* ---- commit-gate modes (0.3). Each defect below is a way the new warn/block/off logic could rot. ---- */
  {
    file: 'commit-gate.js',
    name: 'default mode flipped back to BLOCK',
    guards: 'a new user\'s first commit must not be denied just because docs/ is not linked yet (the 0.3 default)',
    find: "if (v === undefined || v === null || s === 'warn') return { mode: 'warn' };",
    repl: "if (v === undefined || v === null || s === 'warn') return { mode: 'block' };"
  },
  {
    file: 'commit-gate.js',
    name: 'warn output carries permissionDecision "allow"',
    guards: '"allow" skips the user\'s own permission prompt — a warning must never auto-approve a commit',
    find: "hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg }",
    repl: "hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: msg }"
  },
  {
    file: 'commit-gate.js',
    name: 'gateCommit:false no longer bypasses',
    guards: 'users who turned the gate off must stay un-gated',
    find: "if (gate.mode === 'off') return allow(); // deliberate bypass",
    repl: "if (false) return allow(); // deliberate bypass"
  },
  {
    file: 'commit-gate.js',
    name: 'unrecognised gateCommit value switches the gate OFF',
    guards: 'a typo must not silently disable a safety check (same lesson as the lock-guard `protected` fallback)',
    find: "return { mode: 'warn', note:",
    repl: "return { mode: 'off', note:"
  },
  {
    file: 'commit-gate.js',
    name: 'block mode downgraded to warn',
    guards: 'strict mode must stay strict for everyone who opted in (0.1/0.2 configs with true)',
    find: "if (gate.mode === 'warn') {",
    repl: "if (true) {"
  },
  {
    file: 'commit-gate.js',
    name: 'non-commit commands are gated too',
    guards: 'the gate must leave every command except `git commit` alone',
    find: "if (!/\\bgit\\s+commit\\b/.test(cmd)) return allow();",
    repl: "if (false) return allow();"
  },
  {
    file: 'commit-gate.js',
    name: 'clean workspace still warns',
    guards: 'a gate that cries wolf on a healthy workspace teaches people to ignore it (the 0.2 false-alarm lesson)',
    find: "if (issues === 0) return allow();",
    repl: "if (false) return allow();"
  },

  /* ---- init / upgrade (0.3). Every arm is a way a setup tool destroys somebody's project. ---- */
  {
    file: 'init.js',
    name: 'setup overwrites files you already have',
    guards: 'init must NEVER replace an existing CLAUDE.md, decision log or config',
    find: "    if (mode === 'sync') {",
    repl: "    if (true) {"
  },
  {
    file: 'init.js',
    name: '.gitignore lines duplicated on every run',
    guards: 're-running init must be a no-op, not a growing .gitignore',
    find: "const present = new Set(text.split(/\\r?\\n/).map(l => l.trim()));",
    repl: "const present = new Set();"
  },
  {
    file: 'init.js',
    name: '.gitignore appended with the wrong line ending',
    guards: 'a CRLF .gitignore must not turn into a mixed-ending file',
    find: "const eol = /\\r\\n/.test(text) ? '\\r\\n' : '\\n';",
    repl: "const eol = '\\n';"
  },
  {
    file: 'init.js',
    name: '--upgrade also overwrites CLAUDE.md',
    guards: 'upgrade may touch the three project-local scripts and nothing else — CLAUDE.md is yours',
    find: "const UPGRADE_SET = SCRIPT_PAIRS;",
    repl: "const UPGRADE_SET = SCRIPT_PAIRS.concat([['templates/CLAUDE.md', 'CLAUDE.md']]);"
  },
  {
    file: 'init.js',
    name: '--dry-run still creates files',
    guards: 'a dry run that writes is worse than no dry run: people run it to be safe',
    find: "  if (FLAG.dry) return;\n  fs.mkdirSync(path.dirname(dst), { recursive: true });",
    repl: "  fs.mkdirSync(path.dirname(dst), { recursive: true });"
  },
  {
    file: 'init.js',
    name: '--dry-run still appends',
    guards: 'the append path (.gitignore, CLAUDE.md pointers) must honour the dry run too',
    find: "function appendSafe(dst, text) {\n  if (FLAG.dry) return;",
    repl: "function appendSafe(dst, text) {"
  },
  {
    file: 'init.js',
    name: 'auto-memory switched off without being asked',
    guards: 'changing settings.json silently is exactly what this tool promised not to do',
    find: "if (!FLAG.autoMemory) return off ? 'off' : 'on';",
    repl: "if (false) return off ? 'off' : 'on';"
  },
  {
    file: 'init.js',
    name: 'settings.json rewritten without a backup',
    guards: 'the original settings.json must survive as settings.json.dsr-backup',
    find: "if (!fs.existsSync(bak)) writeFileSafe(bak, rawText);",
    repl: "void bak;"
  },
  {
    file: 'init.js',
    name: 'invalid settings.json treated as empty and overwritten',
    guards: 'a settings.json we cannot parse must be left exactly as it is',
    // Anchored on the early `return` of the invalid-JSON branch rather than on the JSON.parse line:
    // that line carries a literal BOM character, which a text anchor cannot reliably reproduce.
    find: "    return 'unknown';\n  }\n  const off =",
    repl: "    void 0;\n  }\n  const off ="
  },
  {
    file: 'init.js',
    name: 'CLAUDE.md pointers appended without --append-pointers',
    guards: 'editing your CLAUDE.md happens only behind an explicit flag',
    find: "if (!FLAG.pointers) return rec('todo'",
    repl: "if (false) return rec('todo'"
  },
  {
    file: 'init.js',
    name: 'pointers appended even when CLAUDE.md already mentions the file',
    guards: 'idempotence: no duplicate pointer lines',
    find: "const missing = POINTERS.filter(([p]) => created.has(p) && text.indexOf(p) === -1);",
    repl: "const missing = POINTERS.filter(([p]) => created.has(p));"
  },
  {
    file: 'init.js',
    name: 'setting up the plugin folder itself is allowed',
    guards: 'running init inside the plugin folder would litter the product tree',
    find: "if (sameOrInside(SRC, project)) die(",
    repl: "if (false) die("
  },
  {
    file: 'init.js',
    name: 'a clone of the plugin repo is accepted as a project',
    guards: 'a folder whose plugin.json says ds-recall is the product, not a project',
    find: "if (pj && pj.name === 'ds-recall') die(",
    repl: "if (false) die("
  },
  {
    file: 'init.js',
    name: 'a missing project folder is created on the fly',
    guards: 'a mistyped path must not silently create a new folder tree',
    find: "if (!isDir) die(",
    repl: "if (false) die("
  },
  {
    file: 'live-check-gate.js',
    name: 'live-check accepts permissionDecision "allow" in warn mode',
    guards: 'the whole point of the live check: a warning that auto-approves the commit must fail it',
    find: "if (allowed) return { verdict: 'FAIL'",
    repl: "if (false) return { verdict: 'FAIL'"
  },
  {
    file: 'live-check-gate.js',
    name: 'live-check turns "not logged in" into a verdict',
    guards: 'an unmeasurable run must be reported as UNMEASURED, never as a pass or a fail',
    find: "if (stream.notLoggedIn) return { verdict: 'UNMEASURED'",
    repl: "if (false) return { verdict: 'UNMEASURED'"
  },
  {
    file: 'live-check-gate.js',
    name: 'live-check ignores the commit count in block mode',
    guards: 'a deny that still left a commit behind is a broken gate',
    find: "if (commits !== 1) return { verdict: 'FAIL', why: 'a blocked",
    repl: "if (false) return { verdict: 'FAIL', why: 'a blocked"
  },
  {
    file: 'init.js',
    name: 'unknown options are accepted',
    guards: 'a typo such as --force must not run a half-meant command',
    find: "if (unknown.length) die(",
    repl: "if (false) die("
  }
];

function runSuite() {
  try { execFileSync(process.execPath, [SUITE], { encoding: 'utf8', stdio: 'pipe' }); return 0; }
  catch (e) { return e.status === undefined ? 99 : e.status; }
}

// Each injection targets ONE source file (default: session-lib.js). Originals are read once and
// kept in memory; every run restores the exact original text right after the suite has run.
const ORIGINALS = {};   // absolute path → original text
function origOf(abs) { if (!(abs in ORIGINALS)) ORIGINALS[abs] = fs.readFileSync(abs, 'utf8'); return ORIGINALS[abs]; }
const targetOf = (inj) => path.join(__dirname, inj.file || path.basename(LIB));
// Anchors are written with \n. A Windows checkout (git autocrlf=true, the Git-for-Windows
// default) turns the working tree into CRLF, so any multi-line anchor silently stopped
// matching and the harness reported FAIL on a perfectly healthy install. Match each file's
// own line ending instead of assuming one. Restore stays byte-exact (we write the original).
const adaptTo = (text, s) => s.replace(/\r?\n/g, text.indexOf('\r\n') !== -1 ? '\r\n' : '\n');
// A crash or Ctrl-C in the middle of a run must never leave a defect behind in the source.
function restoreAll() {
  for (const abs of Object.keys(ORIGINALS)) {
    try { if (fs.readFileSync(abs, 'utf8') !== ORIGINALS[abs]) fs.writeFileSync(abs, ORIGINALS[abs]); } catch (_) {}
  }
}
process.on('exit', restoreAll);
process.on('SIGINT', () => { restoreAll(); process.exit(130); });
let blind = 0, caught = 0, unapplied = 0, notExercised = 0;

console.log('DS-ReCall — negative test of the test suite');
const targets = Array.from(new Set(INJECTIONS.map(targetOf)));
targets.forEach(origOf);
console.log(`source: ${targets.map(t => `${path.basename(t)} (${Buffer.byteLength(origOf(t))} bytes)`).join(' · ')}\n`);

console.log('baseline (unmodified source) …');
const base = runSuite();
console.log(`  exit ${base} — ${base === 0 ? 'GREEN as expected' : 'ALREADY RED, fix the suite before trusting this harness'}\n`);
if (base !== 0) { console.log('RESULT: ABORTED'); process.exit(1); }

for (const raw of INJECTIONS) {
  const target = targetOf(raw);
  const original = origOf(target);
  const inj = Object.assign({}, raw, { find: adaptTo(original, raw.find), repl: adaptTo(original, raw.repl) });
  if (original.indexOf(inj.find) === -1) {
    unapplied++;
    console.log(`? ${inj.name}`);
    console.log(`    anchor not found in ${path.basename(target)} — injection could not be applied (source drifted?)`);
    continue;
  }
  fs.writeFileSync(target, original.replace(inj.find, inj.repl));
  const code = runSuite();
  fs.writeFileSync(target, original);                    // restore immediately, always
  const restored = fs.readFileSync(target, 'utf8') === original;
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
