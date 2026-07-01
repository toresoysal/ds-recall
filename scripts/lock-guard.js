#!/usr/bin/env node
/*
 * DS-ReCall — PreToolUse lock guard (concurrency HARD lock, Moat-2)
 * Korunan kanon dosyalarina (CLAUDE.md, DECISIONS.md ...) yazimi, BASKA taze session
 * kilidi aktifken bloklar -> clobbering imkansiz. Stale kilitler (SessionEnd kacirip
 * birakamayinca kalan hayalet kilitler) staleLockHours TTL'i ile yoksayilir.
 *
 * Input  (stdin JSON): { session_id, cwd, tool_name, tool_input:{ file_path }, ... }
 * Output (stdout JSON): deny  -> { hookSpecificOutput:{ hookEventName:"PreToolUse",
 *                                  permissionDecision:"deny", permissionDecisionReason } }
 *                       allow -> {}  (bos = standart izin akisi devam)
 */
'use strict';
const fs = require('fs');
const path = require('path');

function readStdin() { try { return fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch (_) { return ''; } }
function sanitize(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '-'); }

const DEFAULTS = {
  protected: ['CLAUDE.md', 'DECISIONS.md', 'SESSIONS_INDEX.md'], // basename eslesmesi
  staleLockHours: 12
};

function loadConfig(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  let cfg = DEFAULTS;
  if (fs.existsSync(p)) {
    try { cfg = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))); } catch (_) {}
  }
  // a non-array "protected" (e.g. a single string typo'd instead of a 1-item array)
  // would make .includes() do substring matching and silently drop guard coverage
  // for every OTHER protected file — must not fail silent into a weaker guard.
  if (!Array.isArray(cfg.protected)) cfg.protected = DEFAULTS.protected;
  return cfg;
}

function allow() { process.stdout.write('{}'); }

function main() {
  let input = {};
  const raw = readStdin();
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) {} }

  const root = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sid = input.session_id || process.env.CLAUDE_SESSION_ID || '';
  const cfg = loadConfig(root);

  const ti = input.tool_input || {};
  const filePath = ti.file_path || ti.path || '';
  const base = path.basename(filePath);

  // Hedef korunan kanon degilse -> izin ver
  if (!filePath || !cfg.protected.includes(base)) { return allow(); }

  // active/ kilitlerini tara: kendi haric + TAZE olanlar
  const activeDir = path.join(root, '.claude', 'active');
  if (!fs.existsSync(activeDir)) { return allow(); }

  const mine = sanitize(sid) + '.lock';
  const cutoff = Date.now() - cfg.staleLockHours * 3600 * 1000;
  const others = [];
  for (const f of fs.readdirSync(activeDir)) {
    if (!f.endsWith('.lock') || f === mine) continue;
    let opened = 0;
    try { opened = Date.parse(JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8')).opened) || 0; } catch (_) {}
    if (opened >= cutoff) others.push(f.replace(/\.lock$/, '')); // sadece taze kilitler
  }

  if (others.length === 0) { return allow(); }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[DS-ReCall] "${base}" is shared canon and ${others.length} other active session(s) hold a lock (${others.join(', ')}). `
        + `Writing now risks clobbering. Write to your own session file instead, or consolidate one session at a time (/ds-recall:wrap). `
        + `If those sessions are dead, their locks expire after ${cfg.staleLockHours}h.`
    }
  }));
}

main();
