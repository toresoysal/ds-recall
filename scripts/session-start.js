#!/usr/bin/env node
/*
 * DS-ReCall — SessionStart hook (v0.2)
 * (1) per-session lock + concurrency scan
 * (2) session stub (idempotent, one per session id — NOT one per calendar day)
 * (3) SESSIONS_INDEX line as ⚪ OPEN + catch-up nudge based on REAL WORK
 * (4) system clock injection (date-hallucination shield)
 * (5) auto-memory OFF check (product pre-condition)
 * (6) GC: stubs left behind by sessions that died without SessionEnd
 *
 * ── WHAT CHANGED IN v0.2 AND WHY (measured on the reference workspace, 2026-08-07) ──
 * v0.1 wrote a "🟡 RAW" index line at every SessionStart and counted those lines to
 * produce the catch-up warning. Nothing ever removed them, so the warning grew without
 * bound and stopped meaning anything:
 *
 *     warning said            : 59 sessions still RAW
 *     sessions with real work : 1            (58 stubs had a COMPLETELY EMPTY body)
 *     stub churn              : 10-19/day, 75% empty (255 of 338)
 *     same id, N day-stubs    : 58 ids affected, worst case 5 stubs for one session
 *
 * A warning that is wrong 98% of the time trains the reader to ignore it — which is
 * exactly what happened; the operator was closing sessions by hand and the number kept
 * climbing anyway, because the garbage is created at START, not at the end.
 *
 * v0.2 separates "a session existed" from "a session produced work":
 *   ⚪ OPEN → written here, never warns
 *   🟡 RAW  → written by SessionEnd/wrap ONLY when the stub actually has content
 * and empty stubs are collected instead of accumulating.
 *
 * Input  (stdin JSON): { session_id, cwd, transcript_path, hook_event_name, source }
 * Output (stdout JSON): { hookSpecificOutput: { hookEventName, additionalContext } }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./session-lib.js');

function readStdin() { try { return fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch (_) { return ''; } }

// auto-memory OFF? settings.json autoMemoryEnabled:false OR env → OK. Otherwise: warn.
function autoMemoryOff(root) {
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) return true;
  const p = path.join(root, '.claude', 'settings.json');
  if (fs.existsSync(p)) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
      if (s && s.autoMemoryEnabled === false) return true;
    } catch (_) {}
  }
  return false;
}

function main() {
  let input = {};
  const raw = readStdin();
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) {} }

  const sid = input.session_id || process.env.CLAUDE_SESSION_ID || ('unknown-' + Date.now());
  const root = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = L.loadConfig(root);
  const ssid = L.sanitize(sid);
  const sid8 = ssid.slice(0, 8);
  const ts = L.nowLocal();
  const day = ts.slice(0, 10);
  const claudeDir = path.join(root, '.claude');
  const activeDir = path.join(claudeDir, 'active');

  fs.mkdirSync(activeDir, { recursive: true });

  /* 1) lock */
  const myLock = ssid + '.lock';
  let lockFailed = false;
  try {
    fs.writeFileSync(path.join(activeDir, myLock),
      JSON.stringify({ session_id: sid, cwd: root, opened: ts, source: input.source || null }) + '\n');
  } catch (_) { lockFailed = true; }

  /* 1.5) stale-lock GC — ghost locks from sessions that never reached SessionEnd */
  try {
    const cutoff = Date.now() - (cfg.staleLockHours || 12) * 3600 * 1000;
    for (const f of fs.readdirSync(activeDir)) {
      if (!f.endsWith('.lock') || f === myLock) continue;
      let opened = 0;
      try { opened = Date.parse(JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8')).opened) || 0; } catch (_) {}
      if (opened && opened < cutoff) { try { fs.unlinkSync(path.join(activeDir, f)); } catch (_) {} }
    }
  } catch (_) {}

  /* 2) stub — ONE per session id. Resuming on a later day reuses the original file
        instead of spawning a second empty one (v0.1 produced up to 5 for one session). */
  let stubFailed = false;
  let stubName = day + '-' + sid8 + '.md';
  let stubRel = '';
  try {
    const sessionsDir = L.safeJoin(root, cfg.sessionsDir, L.DEFAULTS.sessionsDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const existing = L.findStubForSid(sessionsDir, sid8);
    if (existing) {
      stubName = existing;
    } else {
      fs.writeFileSync(path.join(sessionsDir, stubName),
        '---\nsession: ' + ssid + '\nopened: ' + ts + '\n---\n'
        + '# Session ' + day + ' · <title at /wrap>\n\n'
        + '## What happened\n<!-- SessionStart opened this (empty). /wrap fills it. Status lives in SESSIONS_INDEX. -->\n\n'
        + '## Decisions (→ DECISIONS.md)\n\n'
        + '## Open threads\n');
    }
    stubRel = (cfg.sessionsDir + '/' + stubName).replace(/\\/g, '/');
  } catch (_) { stubFailed = true; }

  /* 2.5) GC — collect stubs abandoned by sessions that died without SessionEnd.
        Guarded: auto-stub name + empty body + no fresh lock + older than staleLockHours. */
  let gc = null;
  if (cfg.gcEmptyStubs !== false) {
    try { gc = L.gcEmptyStubs(root, cfg); } catch (_) {}
  }

  /* 3) index line — ⚪ OPEN, written under a lock so concurrent starts cannot duplicate it */
  let indexFailed = false;
  try {
    L.setIndexStatus(root, cfg, sid8, L.STATUS.OPEN, { ts: ts, stubRel: stubRel });
  } catch (_) { indexFailed = true; }

  /* 3.5) catch-up — count SESSIONS WITH REAL WORK, not index lines */
  let pending = [];
  try { pending = L.pendingWork(root, cfg, sid8); } catch (_) {}

  /* 4) concurrency */
  let others = [];
  try {
    others = fs.readdirSync(activeDir)
      .filter(function (f) { return f.endsWith('.lock') && f !== myLock; })
      .map(function (f) { return f.replace(/\.lock$/, ''); });
  } catch (_) {}

  /* 5) additionalContext */
  const ctx = ['🕐 System time now: ' + ts + ' (machine local). Treat as authoritative — do not guess the date/time.'];

  if (!autoMemoryOff(root)) {
    ctx.push('⚠ AUTO-MEMORY may be ON. DS-ReCall expects it OFF — set "autoMemoryEnabled": false in .claude/settings.json (or env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1), else uncurated memory runs alongside and drifts.');
  }
  if (others.length > 0) {
    ctx.push('CONCURRENCY: ' + others.length + ' other active session(s) (' + others.map(o => o.slice(0, 8)).join(', ') + '). Avoid writing shared canon (CLAUDE.md, docs/DECISIONS.md); write only your own session file. Consolidate one at a time (' + cfg.wrapCommand + ').');
  }
  if (pending.length > 0) {
    const shown = pending.slice(0, 12).map(p => p.sid8);
    ctx.push('UNCONSOLIDATED WORK: ' + pending.length + ' earlier session(s) have content but no ' + cfg.wrapCommand
      + ' (' + shown.join(', ') + (pending.length > shown.length ? ', +' + (pending.length - shown.length) + ' more' : '') + '). Empty/abandoned stubs are excluded and auto-collected — this count is real work only.');
  }
  if (gc && gc.removed.length > 0) {
    ctx.push('GC: collected ' + gc.removed.length + ' abandoned empty stub(s) (' + gc.empty + ' empty of ' + gc.scanned + ' scanned; kept ' + gc.keptLive + ' live, ' + gc.keptYoung + ' recent).');
  }
  if (lockFailed || stubFailed || indexFailed) {
    const parts = [lockFailed && 'lock', stubFailed && 'session stub', indexFailed && 'SESSIONS_INDEX'].filter(Boolean);
    ctx.push('⚠ WRITE FAILURE: could not write ' + parts.join('/') + ' — check .claude/ exists and is writable. Memory capture may be silently skipped this session.');
  }

  /* NESTED: parent project + up-propagation contract */
  if (cfg.nested !== false) {
    const parent = L.findParentProject(root);
    if (parent) {
      ctx.push('NESTED: sub-project of "' + path.basename(parent) + '" (parent index: ' + path.basename(parent) + '/CLAUDE.md). At ' + cfg.wrapCommand + ' your 1-line dated summary propagates UP to ' + path.basename(parent) + '/.claude/CHILD_FEED.md. Honor the parent’s hard rules; keep this sub-project’s detail here, not in the parent.');
    }
  }

  /* TIME-BLINDNESS: flag a stale local index by its own 'updated' date */
  const upd = L.indexUpdated(root);
  if (upd) {
    const age = L.daysSince(upd);
    if (age !== null && age > (cfg.staleDays || 21)) {
      ctx.push('STALE INDEX: this project’s CLAUDE.md says updated ' + upd + ' (' + age + ' days ago). Verify before trusting; refresh "updated:" at ' + cfg.wrapCommand + '.');
    }
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[DS-ReCall] ' + ctx.join('  |  ') }
  }));
}

main();
