#!/usr/bin/env node
/*
 * DS-ReCall — PreToolUse commit-gate (Moat-1, the deterministic trigger)
 * Blocks `git commit` while memory integrity is FAIL (broken / orphan / unindexed).
 * Integrity therefore depends on the system, not on a human remembering to run /wrap.
 *
 * Fires only on Bash `git commit` commands; every other command is left alone.
 * Turn it off: <root>/.claude/ds-recall.config.json → "gateCommit": false.
 * If the validator itself crashes the commit is NOT blocked (fail-open — a gate must
 * never stop work because of its own bug).
 *
 * Input  (stdin JSON): { cwd, tool_name, tool_input:{ command }, ... }
 * Output (stdout JSON): deny  -> { hookSpecificOutput:{ hookEventName:"PreToolUse",
 *                                  permissionDecision:"deny", permissionDecisionReason } }
 *                       allow -> {}
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

function main() {
  let input = {};
  const raw = readStdin();
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) {} }

  const root = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cmd = (input.tool_input && input.tool_input.command) || '';

  // Only act on real git commits.
  if (!/\bgit\s+commit\b/.test(cmd)) return allow();

  const cfg = loadCfg(root);
  if (cfg.gateCommit === false) return allow(); // deliberate bypass

  let r;
  try { r = computeIntegrity(root); } catch (e) {
    console.error('[DS-ReCall] integrity check crashed — commit-gate fail-open (Moat-1 not enforced this commit): ' + e.message);
    return allow(); // fail-open: gate must not block work, but silence would hide that the guarantee lapsed
  }

  const issues = r.broken.length + r.orphans.length + r.unindexed.length;
  if (issues === 0) return allow();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[DS-ReCall] Commit blocked — memory integrity FAIL: `
        + `${r.broken.length} broken, ${r.orphans.length} orphan, ${r.unindexed.length} unindexed session(s). `
        + `Consolidate with ${cfg.wrapCommand || '/ds-recall:wrap'} (or inspect: node .claude/scripts/validate.js) before committing. `
        + `One-time bypass: set "gateCommit": false in .claude/ds-recall.config.json.`
    }
  }));
}

main();
