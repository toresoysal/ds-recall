#!/usr/bin/env node
/*
 * DS-ReCall — PreToolUse commit-gate (Moat-1 deterministik tetikleyici)
 * git commit'i, memory integrity FAIL (broken / orphan / unindexed) iken BLOKLAR.
 * Böylece bütünlük, insanın /wrap'i hatırlamasına değil SİSTEME bağlanır.
 *
 * Sadece Bash 'git commit' komutlarında devreye girer (diğer her şeye dokunmaz).
 * Kapatma: <root>/.claude/ds-recall.config.json → "gateCommit": false.
 * Validator patlarsa commit ENGELLENMEZ (fail-open — gate, işi durdurmamalı).
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

  // Sadece gerçek git commit'lerde devreye gir.
  if (!/\bgit\s+commit\b/.test(cmd)) return allow();

  const cfg = loadCfg(root);
  if (cfg.gateCommit === false) return allow(); // bilinçli bypass

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
