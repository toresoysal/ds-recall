#!/usr/bin/env node
/*
 * DS-ReCall — PreToolUse commit-gate (Moat-1, the deterministic trigger)
 * Watches `git commit` while memory integrity is FAIL (broken / orphan / unindexed).
 * Integrity therefore depends on the system, not on a human remembering to run /wrap.
 *
 * Fires only on Bash `git commit` commands; every other command is left alone.
 *
 * Mode — <root>/.claude/ds-recall.config.json → "gateCommit":
 *   "warn"  (DEFAULT, also when the key is absent or unrecognised) — the commit goes through,
 *           the user sees a warning and Claude gets the same text as context.
 *   true | "block"  — the commit is BLOCKED while integrity is FAIL (the 0.1/0.2 behaviour).
 *   false | "off"   — the gate does nothing.
 * Why warn is the default (0.3.0): on a fresh install in a repo whose docs/ folder is not linked
 * from CLAUDE.md, every commit used to be denied (measured: orphan=1). A gate that stops a new
 * user's first commit is a poor first impression; blocking stays one config line away.
 *
 * If the validator itself crashes the commit is NOT blocked (fail-open — a gate must
 * never stop work because of its own bug).
 *
 * Input  (stdin JSON): { cwd, tool_name, tool_input:{ command }, ... }
 * Output (stdout JSON): block -> { hookSpecificOutput:{ hookEventName:"PreToolUse",
 *                                   permissionDecision:"deny", permissionDecisionReason } }
 *                       warn  -> { systemMessage, hookSpecificOutput:{ hookEventName:"PreToolUse",
 *                                   additionalContext } }   (NO permissionDecision on purpose:
 *                                   "allow" would skip the user's permission prompt)
 *                       none  -> {}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { computeIntegrity } = require('./validate.js');

function readStdin() { try { return fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch (_) { return ''; } }
function allow() { process.stdout.write('{}'); }

function loadCfg(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) {}
  }
  return {};
}

// "gateCommit" → { mode: 'off' | 'warn' | 'block', note? }. An unrecognised value falls to WARN,
// never to 'off': a typo must not silently switch a safety check off (the same lesson as the
// lock-guard's non-array `protected`), and it must not silently start blocking commits either.
function gateMode(cfg) {
  const v = cfg.gateCommit;
  const s = (typeof v === 'string') ? v.trim().toLowerCase() : null;
  if (v === false || s === 'false' || s === 'off') return { mode: 'off' };
  if (v === true || s === 'true' || s === 'block') return { mode: 'block' };
  if (v === undefined || v === null || s === 'warn') return { mode: 'warn' };
  return { mode: 'warn', note: ' (note: gateCommit value ' + JSON.stringify(v) + ' is not recognised — treated as "warn")' };
}

function main() {
  let input = {};
  const raw = readStdin();
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) {} }

  const root = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cmd = (input.tool_input && input.tool_input.command) || '';

  // Only act on real git commits.
  if (!/\bgit\s+commit\b/.test(cmd)) return allow();

  const cfg = loadCfg(root);
  const gate = gateMode(cfg);
  if (gate.mode === 'off') return allow(); // deliberate bypass

  let r;
  try { r = computeIntegrity(root); } catch (e) {
    console.error('[DS-ReCall] integrity check crashed — commit-gate fail-open (Moat-1 not enforced this commit): ' + e.message);
    return allow(); // fail-open: gate must not block work, but silence would hide that the guarantee lapsed
  }

  const issues = r.broken.length + r.orphans.length + r.unindexed.length;
  if (issues === 0) return allow();

  if (gate.mode === 'warn') {
    const msg = `[DS-ReCall] Memory integrity FAIL — this commit was NOT blocked (gateCommit is "warn"): `
      + `${r.broken.length} broken, ${r.orphans.length} orphan, ${r.unindexed.length} unindexed session(s). `
      + `Inspect: node .claude/scripts/validate.js · consolidate with ${cfg.wrapCommand || '/ds-recall:wrap'}. `
      + `To block commits while integrity fails set "gateCommit": "block" in .claude/ds-recall.config.json; to silence this set "gateCommit": false.`
      + (gate.note || '');
    // No permissionDecision here: "allow" would skip the user's own permission prompt for the commit.
    process.stdout.write(JSON.stringify({
      systemMessage: msg,
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg }
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[DS-ReCall] Commit blocked — memory integrity FAIL: `
        + `${r.broken.length} broken, ${r.orphans.length} orphan, ${r.unindexed.length} unindexed session(s). `
        + `Consolidate with ${cfg.wrapCommand || '/ds-recall:wrap'} (or inspect: node .claude/scripts/validate.js) before committing. `
        + `Warn instead of block: set "gateCommit": "warn"; turn it off: "gateCommit": false (both in .claude/ds-recall.config.json).`
    }
  }));
}

main();
