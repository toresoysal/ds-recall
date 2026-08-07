#!/usr/bin/env node
/*
 * DS-ReCall — shared session helpers (v0.2)
 *
 * Why this file exists (measured on the reference workspace, 2026-08-07):
 *   SessionStart wrote a stub + a "🟡 RAW" index line for EVERY session, unconditionally.
 *   Nothing ever removed them. After 6 days the catch-up warning said
 *   "59 earlier session(s) still RAW" — 58 of those stubs had a COMPLETELY EMPTY body.
 *   The warning was measuring "did a line get written", not "is there work to consolidate".
 *   A gate that cries wolf 98% of the time is worse than no gate: nobody reads it.
 *
 * The fix is a real status machine, not a louder warning:
 *   ⚪ OPEN          session started, no work captured yet   → NEVER warns
 *   🟡 RAW           the stub has real content, /wrap pending → the ONLY thing that warns
 *   ✅ CONSOLIDATED  /wrap folded it into curated memory
 *   ⚪ CLOSED        legacy marker for abandoned empty stubs (kept for back-compat; GC now removes)
 *
 * Everything here is sync-only and crash-tolerant: these run inside short-lived hook
 * processes and must never block or throw a session to death.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ time */

function pad(n) { return (n < 10 ? '0' : '') + n; }
function nowLocal(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function sanitize(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '-'); }

/* ------------------------------------------------------------- containment */

// A copied/malformed ds-recall.config.json (e.g. "sessionsDir": "../../outside") must not
// turn a hook into an arbitrary-path write primitive. Falls back to `fallbackRel`.
function safeJoin(root, rel, fallbackRel) {
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(root, rel);
  if (resolved === rootAbs || resolved.startsWith(rootAbs + path.sep)) return resolved;
  return path.resolve(root, fallbackRel);
}

/* ------------------------------------------------------------------ config */

const DEFAULTS = {
  sessionsDir: 'docs/sessions',
  staleLockHours: 12,
  staleDays: 21,
  nested: true,
  propagateToParent: true,
  wrapCommand: '/ds-recall:wrap',
  statusCommand: '/ds-recall:status',
  // v0.2
  gcEmptyStubs: true,        // delete abandoned EMPTY stubs (crashed sessions leave them behind)
  backupCompressDays: 14,    // gzip transcript backups older than N days (0 = off)
  backupCompressPerRun: 5,   // cap per hook run so a large backlog cannot stall SessionEnd
  backupDeleteDays: 0,       // hard-delete .gz older than N days (0 = never delete; default is LOSSLESS)
  maxIndexLineChars: 0       // 0 = no limit. >0 warns when an index line carries a long summary
};

function loadConfig(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  if (fs.existsSync(p)) {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))); }
    catch (_) { /* malformed config must never kill a session */ }
  }
  return Object.assign({}, DEFAULTS);
}

/* -------------------------------------------------- stub emptiness (core) */

// Auto-stub filenames only. Hand-written session notes (e.g. "2026-06-19_release-notes.md")
// must NEVER be touched by GC — the pattern is the safety boundary.
const STUB_RE = /^(\d{4}-\d{2}-\d{2})-([0-9a-zA-Z_-]{8})\.md$/;

function isAutoStubName(name) { return STUB_RE.test(name); }

// Strip the template scaffolding SessionStart wrote and see if anything human remains.
// Deliberately conservative: >20 surviving chars counts as REAL WORK (never GC a maybe).
function stubBody(content) {
  return String(content)
    .replace(/^---[\s\S]*?\n---\s*\n?/, '')   // frontmatter
    .replace(/^#[^\n]*\n?/, '')               // H1 title
    .replace(/<!--[\s\S]*?-->/g, '')          // HTML comments (the template hint lives here)
    .replace(/^##[^\n]*$/gm, '')              // empty section headings
    .replace(/\s+/g, ' ')
    .trim();
}
function isEmptyStub(content) { return stubBody(content).length <= 20; }

function readStubInfo(sessionsAbs, fileName) {
  const p = path.join(sessionsAbs, fileName);
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
  const m = fileName.match(STUB_RE);
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
  return {
    file: fileName,
    abs: p,
    day: m ? m[1] : null,
    sid8: m ? m[2] : null,
    empty: isEmptyStub(content),
    bodyChars: stubBody(content).length,
    closed: /^closed:\s*\S/m.test(content),
    mtime: mtime
  };
}

// Find an EXISTING stub for this session id, regardless of which day it was opened.
// Before v0.2 a session resumed on a later day got a SECOND empty stub (measured: 58 ids
// had 2-5 day-stubs each; one had 5). Reusing the first one kills that whole class.
function findStubForSid(sessionsAbs, sid8) {
  try {
    const hit = fs.readdirSync(sessionsAbs)
      .filter(isAutoStubName)
      .filter(f => f.endsWith('-' + sid8 + '.md'))
      .sort();
    return hit.length ? hit[0] : null;
  } catch (_) { return null; }
}

/* --------------------------------------------------- index write serialisation */

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } }
}

// check-then-append is NOT atomic. Two SessionStarts firing together both read "id absent"
// and both append → duplicate line. Measured once in the wild (472f6832 listed twice).
// Short-lived advisory lock; NEVER blocks a session for more than ~1s and always falls
// through to a best-effort write rather than losing the record.
function withIndexLock(claudeDir, fn) {
  const lp = path.join(claudeDir, '.index.lock');
  for (let i = 0; i < 40; i++) {
    let fd = null;
    try { fd = fs.openSync(lp, 'wx'); }
    catch (_) {
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > 10000) { fs.unlinkSync(lp); continue; } // stale → steal
      } catch (_) { continue; }
      sleepSync(25);
      continue;
    }
    try { return fn(); }
    finally {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(lp); } catch (_) {}
    }
  }
  return fn(); // lock unobtainable → do the work anyway; a dup beats a lost session
}

/* ------------------------------------------------------------- index model */

const STATUS = { OPEN: '⚪ OPEN', RAW: '🟡 RAW', CONSOLIDATED: '✅ CONSOLIDATED', CLOSED: '⚪ CLOSED' };
const STATUS_RE = /(⚪\s*OPEN|🟡\s*RAW|✅\s*CONSOLIDATED|⚪\s*CLOSED)/;

function indexPath(root, cfg) {
  return safeJoin(root, (cfg && cfg.sessionsIndex) || '.claude/SESSIONS_INDEX.md', '.claude/SESSIONS_INDEX.md');
}

function ensureIndex(file, cfg) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    '# DS-ReCall — Sessions Index\n'
    + '> ⚪ OPEN = session started, nothing captured yet (never warns).\n'
    + '> 🟡 RAW = the session file has real content and ' + ((cfg && cfg.wrapCommand) || '/ds-recall:wrap') + ' has not run — THIS is what the catch-up warning counts.\n'
    + '> ✅ CONSOLIDATED = folded into curated memory.  ⚪ CLOSED = legacy empty/abandoned stub.\n\n');
}

// A session line is `- S-<id8> · … · <status> · …`
//
// Legacy indexes also contain DAY-SUFFIXED variants of the same id — `- S-a6278ad3-0806 · …`
// — written by hand when v0.1's resume bug produced a second stub for one session. So a
// single id can own several lines with DIFFERENT statuses: the suffixed one saying ⚪ CLOSED
// and the canonical one saying ✅ CONSOLIDATED.
//
// Taking "the first line that contains this id" therefore reads the WRONG status, and that
// is not a cosmetic error: it made already-consolidated sessions reappear as pending work.
// Match strictly (id followed by a separator) and treat suffixed lines as a fallback only.
function isSessionLine(line, sid8) {
  return line.startsWith('- S-') && line.indexOf('S-' + sid8) !== -1;
}
function isExactSessionLine(line, sid8) {
  return new RegExp('^- S-' + sid8 + '(?=\\s|·|$)').test(line);
}
// All lines belonging to this id, canonical (exact) first.
function sessionLinesFor(lines, sid8) {
  const exact = [], suffixed = [];
  for (const l of lines) {
    if (!isSessionLine(l, sid8)) continue;
    (isExactSessionLine(l, sid8) ? exact : suffixed).push(l);
  }
  return exact.concat(suffixed);
}
// A session is done if ANY of its lines says so — never just the first one found.
function isConsolidated(lines, sid8) {
  return sessionLinesFor(lines, sid8).some(l => /✅\s*CONSOLIDATED/.test(l));
}

function readIndexLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch (_) { return []; }
}

/**
 * Set (or insert) the status of one session in SESSIONS_INDEX.
 * Returns { action: 'inserted'|'updated'|'unchanged'|'removed', line }
 */
function setIndexStatus(root, cfg, sid8, status, opts) {
  opts = opts || {};
  const claudeDir = path.join(root, '.claude');
  const file = indexPath(root, cfg);
  return withIndexLock(claudeDir, () => {
    ensureIndex(file, cfg);
    const lines = readIndexLines(file);
    // Prefer the canonical `- S-<id> ·` line; only fall back to a day-suffixed legacy line
    // if no canonical one exists. Editing the wrong line is how a consolidated session
    // silently reverts to pending.
    let hitIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (isExactSessionLine(lines[i], sid8)) { hitIdx = i; break; }
    }
    if (hitIdx === -1) {
      for (let i = 0; i < lines.length; i++) {
        if (isSessionLine(lines[i], sid8)) { hitIdx = i; break; }
      }
    }

    if (status === null) { // removal (GC of an abandoned empty stub)
      if (hitIdx === -1) return { action: 'unchanged' };
      const removed = lines.splice(hitIdx, 1)[0];
      fs.writeFileSync(file, lines.join('\n'));
      return { action: 'removed', line: removed };
    }

    if (hitIdx === -1) {
      const line = '- S-' + sid8 + ' · ' + (opts.ts || nowLocal()) + ' · ' + status
        + (opts.stubRel ? ' · ' + opts.stubRel : '')
        + (opts.note ? ' · ' + opts.note : '');
      // append without a trailing-newline gap
      const body = fs.readFileSync(file, 'utf8').replace(/\n*$/, '\n');
      fs.writeFileSync(file, body + line + '\n');
      return { action: 'inserted', line };
    }

    const old = lines[hitIdx];
    // Never downgrade: CONSOLIDATED is terminal, RAW must not fall back to OPEN.
    if (/✅\s*CONSOLIDATED/.test(old)) return { action: 'unchanged', line: old };
    if (status === STATUS.OPEN && /🟡\s*RAW/.test(old)) return { action: 'unchanged', line: old };

    let next = STATUS_RE.test(old) ? old.replace(STATUS_RE, status) : old + ' · ' + status;
    if (opts.note) next += ' · ' + opts.note;
    if (next === old) return { action: 'unchanged', line: old };
    lines[hitIdx] = next;
    fs.writeFileSync(file, lines.join('\n'));
    return { action: 'updated', line: next };
  });
}

/**
 * The catch-up question, asked correctly.
 * OLD: "how many index lines say RAW?"          → 59, of which 58 were empty scaffolding
 * NEW: "how many session files hold real work    → the honest number
 *       that /wrap has not consolidated?"
 * Cross-checks the index against the actual file body — the index alone can lie.
 */
function pendingWork(root, cfg, excludeSid8) {
  const sessionsAbs = safeJoin(root, cfg.sessionsDir, DEFAULTS.sessionsDir);
  const file = indexPath(root, cfg);
  const out = [];
  if (!fs.existsSync(sessionsAbs)) return out;

  const idx = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const idxLines = idx.split('\n');

  let names = [];
  try { names = fs.readdirSync(sessionsAbs).filter(isAutoStubName); } catch (_) { return out; }

  const seen = new Set();
  for (const name of names) {
    const info = readStubInfo(sessionsAbs, name);
    if (!info || !info.sid8) continue;
    if (excludeSid8 && info.sid8 === excludeSid8) continue;
    if (info.empty) continue;                 // ← the whole point: empty is not pending work
    if (seen.has(info.sid8)) continue;
    seen.add(info.sid8);

    // consolidated in the index? then it is done regardless of file size.
    // Checks EVERY line for this id, not the first — see isConsolidated().
    if (isConsolidated(idxLines, info.sid8)) continue;
    const line = sessionLinesFor(idxLines, info.sid8)[0];
    out.push({ sid8: info.sid8, file: name, bodyChars: info.bodyChars, indexed: !!line });
  }
  return out;
}

/**
 * Garbage-collect stubs from sessions that died without SessionEnd.
 * Measured: 88 of 338 stubs had no `closed:` stamp — SessionEnd never fired for them
 * (crash / app kill). Their empty stubs and index lines lived forever.
 *
 * Guards (all must hold before anything is deleted):
 *   - filename matches the auto-stub pattern (hand-written notes are out of scope)
 *   - body is empty (>20 surviving chars = keep, always)
 *   - no FRESH lock for that session id (a live session keeps its stub)
 *   - file is older than staleLockHours (a just-opened session keeps its stub)
 */
function gcEmptyStubs(root, cfg, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const sessionsAbs = safeJoin(root, cfg.sessionsDir, DEFAULTS.sessionsDir);
  const activeDir = path.join(root, '.claude', 'active');
  const res = { scanned: 0, empty: 0, removed: [], keptLive: 0, keptYoung: 0, keptWork: 0 };
  if (!fs.existsSync(sessionsAbs)) return res;

  const cutoff = Date.now() - (cfg.staleLockHours || 12) * 3600 * 1000;
  const live = new Set();
  try {
    for (const f of fs.readdirSync(activeDir)) {
      if (!f.endsWith('.lock')) continue;
      let opened = 0;
      try { opened = Date.parse(JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8')).opened) || 0; } catch (_) {}
      if (opened >= cutoff) live.add(f.replace(/\.lock$/, '').slice(0, 8));
    }
  } catch (_) {}

  let names = [];
  try { names = fs.readdirSync(sessionsAbs).filter(isAutoStubName); } catch (_) { return res; }

  for (const name of names) {
    res.scanned++;
    const info = readStubInfo(sessionsAbs, name);
    if (!info) continue;
    if (!info.empty) { res.keptWork++; continue; }
    res.empty++;
    if (info.sid8 && live.has(info.sid8)) { res.keptLive++; continue; }
    if (info.mtime && info.mtime > cutoff) { res.keptYoung++; continue; }
    if (!dryRun) {
      try { fs.unlinkSync(info.abs); } catch (_) { continue; }
      // only drop the index line when NO other stub for this id survives
      if (info.sid8 && !findStubForSid(sessionsAbs, info.sid8)) {
        setIndexStatus(root, cfg, info.sid8, null);
      }
    }
    res.removed.push(name);
  }
  return res;
}

/* ------------------------------------------------------- backup rotation */

/**
 * Transcript backups grew to 1.034 MB / 76 files with no rotation (measured 2026-08-07;
 * single largest file 76,9 MB). Nothing reads them — SessionEnd only writes.
 *
 * Default policy is LOSSLESS: gzip old transcripts in place, never delete.
 * Deletion only happens if backupDeleteDays is explicitly set > 0 by the operator.
 */
function rotateBackups(root, cfg, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const dir = path.join(root, '.claude', 'backups');
  const res = { compressed: [], deleted: [], savedBytes: 0, errors: 0, skipped: 0 };
  if (!fs.existsSync(dir)) return res;

  const cDays = Number(cfg.backupCompressDays || 0);
  const dDays = Number(cfg.backupDeleteDays || 0);
  const perRun = Number(cfg.backupCompressPerRun || 5);
  const now = Date.now();

  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { return res; }

  for (const f of files) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isFile()) continue;
    const ageDays = (now - st.mtimeMs) / 86400000;

    if (cDays > 0 && f.endsWith('.jsonl') && ageDays > cDays) {
      if (dryRun) { res.compressed.push(f); continue; }
      if (res.compressed.length >= perRun) { res.skipped++; continue; } // don't stall a hook on a big backlog
      try {
        // VERIFY-THEN-DELETE. The original is only unlinked after the compressed copy has
        // been read back off disk and decompressed to the exact original byte length.
        // Order matters: gzip → write → read back → verify → THEN unlink. Any failure
        // (disk full, path collision, corrupt write) leaves the original untouched.
        const src = fs.readFileSync(p);
        const gz = zlib.gzipSync(src, { level: 9 });
        fs.writeFileSync(p + '.gz', gz);
        const back = zlib.gunzipSync(fs.readFileSync(p + '.gz'));
        if (back.length !== src.length) throw new Error('round-trip verify failed');
        fs.unlinkSync(p);
        res.savedBytes += src.length - gz.length;
        res.compressed.push(f);
      } catch (_) { res.errors++; }
      continue;
    }

    if (dDays > 0 && f.endsWith('.gz') && ageDays > dDays) {
      if (dryRun) { res.deleted.push(f); continue; }
      try { fs.unlinkSync(p); res.deleted.push(f); } catch (_) { res.errors++; }
    }
  }
  return res;
}

/* ------------------------------------------------------------------ misc */

// nearest ancestor ABOVE root that has its own CLAUDE.md = parent project
function findParentProject(root) {
  let dir = path.dirname(root), prev = null;
  for (let i = 0; i < 24 && dir && dir !== prev; i++) {
    try { if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) return dir; } catch (_) {}
    prev = dir; dir = path.dirname(dir);
  }
  return null;
}

function indexUpdated(root) {
  try {
    const c = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    const m = c.match(/updated:\s*(\d{4}-\d{2}-\d{2})/i)
      || c.match(/LAST UPDATED:\s*(\d{4}-\d{2}-\d{2})/i)
      || c.match(/SON G[ÜU]NCELLEME:?\s*(\d{4}-\d{2}-\d{2})/i);
    return m ? m[1] : null;
  } catch (_) { return null; }
}
function daysSince(dateStr) {
  const t = Date.parse(dateStr + 'T00:00:00');
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

module.exports = {
  DEFAULTS, STATUS, STATUS_RE, STUB_RE,
  pad, nowLocal, sanitize, safeJoin, loadConfig,
  isAutoStubName, stubBody, isEmptyStub, readStubInfo, findStubForSid,
  withIndexLock, indexPath, ensureIndex, readIndexLines, setIndexStatus,
  isSessionLine, isExactSessionLine, sessionLinesFor, isConsolidated,
  pendingWork, gcEmptyStubs, rotateBackups,
  findParentProject, indexUpdated, daysSince
};
