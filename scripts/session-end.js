#!/usr/bin/env node
/*
 * DS-ReCall — SessionEnd hook (v0.2, deterministic safety net, best-effort)
 *
 * Responsibilities:
 *   1) back up the transcript
 *   2) rotate old backups (gzip; LOSSLESS by default — nothing is deleted unless asked)
 *   3) decide what this session actually was:
 *        stub EMPTY  → it produced nothing → delete the stub AND its index line
 *        stub HAS WORK → stamp `closed:` and flip the index line to 🟡 RAW (wrap is owed)
 *   4) feed the parent project's CHILD_FEED — but ONLY when there is something to feed
 *   5) release the lock
 *
 * ── WHY 3 AND 4 CHANGED IN v0.2 ──
 * v0.1 never cleaned up after itself. Measured on the reference workspace, 2026-08-07:
 *   255 of 338 auto-stubs (75%) had a completely empty body and lived forever
 *   .claude/backups reached 1.034 MB across 76 files, largest single file 76,9 MB
 *   CHILD_FEED collected 12 "(session ended — detail: …)" placeholder lines with no content
 * The hook that creates the record must also be the one that retracts it when the record
 * turns out to be empty. Otherwise every crash and every idle window leaves litter, and
 * the catch-up warning drowns in it.
 *
 * SessionEnd is NOT guaranteed to fire (measured: 88 of 338 stubs never got a `closed:`
 * stamp). That is why SessionStart also runs the same GC — this is a safety net, not the
 * only line of defence.
 *
 * Input (stdin JSON): { session_id, cwd, transcript_path, hook_event_name, reason }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./session-lib.js');

function readStdin() { try { return fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch (_) { return ''; } }

function main() {
  let input = {};
  const raw = readStdin();
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) {} }

  const sid = input.session_id || ('unknown-' + Date.now());
  const root = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const transcript = input.transcript_path || '';
  const ssid = L.sanitize(sid);
  const sid8 = ssid.slice(0, 8);
  const cfg = L.loadConfig(root);

  const claudeDir = path.join(root, '.claude');
  const backupsDir = path.join(claudeDir, 'backups');
  const activeDir = path.join(claudeDir, 'active');
  fs.mkdirSync(backupsDir, { recursive: true });

  /* 1) back up the transcript */
  if (transcript && fs.existsSync(transcript)) {
    try { fs.copyFileSync(transcript, path.join(backupsDir, ssid + '.jsonl')); } catch (_) {}
  }

  /* 2) rotate — gzip old transcripts. Lossless unless backupDeleteDays is set. */
  try { L.rotateBackups(root, cfg); } catch (_) {}

  /* 3) empty vs real work — the whole point of v0.2 */
  let hadWork = false;
  let stubFile = null;
  try {
    const sessionsDir = L.safeJoin(root, cfg.sessionsDir, L.DEFAULTS.sessionsDir);
    if (fs.existsSync(sessionsDir)) {
      stubFile = L.findStubForSid(sessionsDir, sid8);
      if (stubFile) {
        const info = L.readStubInfo(sessionsDir, stubFile);
        if (info && !info.empty) {
          hadWork = true;
          // closing stamp (idempotent)
          const sp = path.join(sessionsDir, stubFile);
          let c = fs.readFileSync(sp, 'utf8');
          if (!/^closed:/m.test(c)) {
            c = c.replace(/^(---\r?\n)/, '$1closed: ' + L.nowLocal() + '\n');
            fs.writeFileSync(sp, c);
          }
        } else if (info && info.empty) {
          // this session produced nothing — retract the record instead of leaving litter
          try { fs.unlinkSync(info.abs); } catch (_) {}
        }
      }
    }
  } catch (_) {}

  /* 3b) index: RAW when there is work to consolidate, otherwise remove the line entirely */
  try {
    if (hadWork) {
      L.setIndexStatus(root, cfg, sid8, L.STATUS.RAW);
    } else {
      const sessionsDir = L.safeJoin(root, cfg.sessionsDir, L.DEFAULTS.sessionsDir);
      // only drop the line when no stub for this id survives anywhere
      if (!L.findStubForSid(sessionsDir, sid8)) L.setIndexStatus(root, cfg, sid8, null);
    }
  } catch (_) {}

  /* 4) up-propagate to the parent — only if this session actually did something.
        v0.1 appended a placeholder for every session, including empty ones. */
  if (cfg.propagateToParent !== false && hadWork) {
    const parent = L.findParentProject(root);
    if (parent) {
      try {
        const pcDir = path.join(parent, '.claude');
        fs.mkdirSync(pcDir, { recursive: true });
        const feed = path.join(pcDir, 'CHILD_FEED.md');
        if (!fs.existsSync(feed)) {
          fs.writeFileSync(feed,
            '# Child feed — sub-project session digests (append-only)\n'
            + '> 1 line per sub-project session THAT PRODUCED WORK. ' + cfg.wrapCommand
            + ' writes the meaningful summary; SessionEnd appends a placeholder only if wrap did not run.\n\n');
        }
        if (fs.readFileSync(feed, 'utf8').indexOf('S-' + sid8) === -1) {
          fs.appendFileSync(feed, '- ' + path.basename(root) + ' · ' + L.nowLocal() + ' · S-' + sid8
            + ' · (ended without ' + cfg.wrapCommand + ' — detail: ' + path.basename(root) + '/' + cfg.sessionsDir + '/' + (stubFile || '') + ')\n');
        }
      } catch (_) {}
    }
  }

  /* 5) release the lock */
  const lock = path.join(activeDir, ssid + '.lock');
  if (fs.existsSync(lock)) { try { fs.unlinkSync(lock); } catch (_) {} }

  process.stdout.write('{}');
}

main();
