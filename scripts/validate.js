#!/usr/bin/env node
/*
 * DS-ReCall — memory integrity validator (cross-platform).
 *
 * Checks:
 *   BROKEN     — an index file references a .md that does not exist on disk (dead link)
 *   ORPHAN     — a .md under a tracked directory that no index file references (lost-knowledge risk)
 *   UNINDEXED  — a session file in sessionsDir that has no line in SESSIONS_INDEX (drift)
 *   SIZE       — an index file is over the line/byte threshold (warning only, never a failure)
 *
 * Exit code: 0 = clean, 1 = broken/orphan/unindexed found (used by the commit-gate and CI).
 * CLI usage:    node validate.js [projectRoot]   (falls back to CLAUDE_PROJECT_DIR, then cwd)
 * Module usage: const { computeIntegrity } = require('./validate.js'); computeIntegrity(root)
 * Optional config: <root>/.claude/ds-recall.config.json overrides DEFAULTS.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

const DEFAULTS = {
  indexes: ['CLAUDE.md'],                 // reference SOURCE (root-relative). Sub-indexes can be added, e.g. 'docs/research/README.md'
  tracked: ['docs'],                      // directories scanned for orphans (root-relative)
  sessionsDir: 'docs/sessions',           // auto-stub directory → exempt from ORPHAN (SESSIONS_INDEX tracks it)
  sessionsIndex: '.claude/SESSIONS_INDEX.md', // reference for the session-coverage (UNINDEXED) check
  sizeLimitLines: 200,                    // index line-count warning threshold
  sizeLimitBytes: 25 * 1024,              // index byte warning threshold (Claude Code's own MEMORY.md read limit is also 25KB)
  ignore: ['node_modules', '.git']        // names never scanned
};

function loadConfig(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  if (fs.existsSync(p)) {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))); }
    catch (e) { console.error(`! config parse error (${p}), using defaults: ${e.message}`); }
  }
  return DEFAULTS;
}

// A copied/malformed ds-recall.config.json (e.g. "tracked": ["../secret"]) must not turn
// the validator into a primitive that reads/reports files outside the project root.
function isContained(root, resolved) {
  const rootAbs = path.resolve(root);
  return resolved === rootAbs || resolved.startsWith(rootAbs + path.sep);
}
// Single-value config path (sessionsDir, sessionsIndex) — falls back to the default if it escapes.
function safeResolve(root, rel, fallbackRel) {
  const resolved = path.resolve(root, rel);
  return isContained(root, resolved) ? resolved : path.resolve(root, fallbackRel);
}

// Extract the local .md references from a piece of markdown.
// 1) [text](path.md) markdown links  2) paths inside `backticks`  3) bare paths that contain a '/'.
// Bare file-name mentions (prose such as "MEMORY.md") are deliberately excluded so they cannot raise a false BROKEN.
//
// PATHS WITH SPACES (fixed 2026-08-02): a path like "my project/notes.md" used to produce a
// PHANTOM BROKEN entry — the bare-path pattern's character class had no space in it, so the
// match started AFTER the space and invented a non-existent "project/notes.md". The gate said
// FAIL while the file sat right there on disk. A gate that raises false red is worse than no
// gate at all, because nobody reads FAIL any more.
// The fix has three branches: markdown links (space + %20 -> decodeURIComponent), backtick
// spans (the backtick is the boundary, so spaces are safe there), and bare paths scanned only
// AFTER backtick spans have been removed — skip that last condition and the phantom returns.
function extractRefs(content) {
  const refs = new Set();
  const add = (raw) => {
    let p = String(raw).replace(/\\/g, '/').trim();
    if (!p || /^https?:/i.test(p)) return;
    // markdown linklerinde bosluk %20 ile yazilabilir -> coz. Bozuk kacista ham hali kalsin.
    if (p.includes('%')) { try { p = decodeURIComponent(p); } catch (_) { /* ham hali */ } }
    refs.add(p);
  };

  // 1) [text](path.md) — parantez siniri belirledigi icin bosluk ve %20 guvenli.
  for (const m of content.matchAll(/\]\(\s*([^)#]+?\.md)(?:#[^)]*)?\s*\)/g)) add(m[1]);

  // 2) paths inside `backticks` — folder names WITH SPACES live here.
  //    The backtick is a hard boundary, so allowing spaces cannot swallow surrounding prose.
  //    The spans are REMOVED from the text at the same time so that step 3 does not see them again.
  const ticked = [];
  const stripped = content.replace(/`([^`\n]+)`/g, (_whole, inner) => {
    ticked.push(inner);
    return ' ';
  });
  for (const t of ticked) {
    const s = t.trim();
    if (/\.md$/i.test(s) && s.includes('/') && !/[<>|*?]/.test(s)) add(s);
  }

  // 3) bare paths (outside backticks, no spaces) — the original behaviour, preserved exactly.
  for (const m of stripped.matchAll(/(?:^|[\s("'])((?:\.{0,2}\/)?[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.md)/gm)) add(m[1]);

  return refs;
}

// List every .md file under a directory, recursively (names in `ignore` are skipped).
function listMd(dir, ignore) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMd(full, ignore));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// Integrity computation — pure (no side effects, no process.exit). The CLI and the commit-gate hook share this function.
function computeIntegrity(root) {
  const cfg = loadConfig(root);
  const referenced = new Set();   // mutlak path
  const broken = [];

  for (const idx of cfg.indexes) {
    const idxPath = path.resolve(root, idx);
    if (!isContained(root, idxPath)) { console.error(`! index outside the project root rejected (config escape): ${idx}`); continue; }
    if (!fs.existsSync(idxPath)) { console.error(`! index file not found: ${idx}`); continue; }
    const content = fs.readFileSync(idxPath, 'utf8');
    for (const ref of extractRefs(content)) {
      // A reference resolves relative to the folder of the index file it appears in → a sub-index (docs/research/README.md) just works.
      const target = path.resolve(path.dirname(idxPath), ref);
      referenced.add(target);
      // anything under .claude/ is runtime/config (SESSIONS_INDEX etc.) and out of integrity scope — it is created during a session
      const isRuntime = /(^|\/)\.claude\//.test(ref.replace(/\\/g, '/'));
      if (!fs.existsSync(target) && !isRuntime) broken.push(`${idx} -> ${ref}`);
    }
  }

  const orphans = [];
  const sessionsAbs = cfg.sessionsDir ? safeResolve(root, cfg.sessionsDir, DEFAULTS.sessionsDir) : null;
  for (const td of cfg.tracked) {
    const tdPath = path.resolve(root, td);
    if (!isContained(root, tdPath)) { console.error(`! tracked dir outside the project root rejected (config escape): ${td}`); continue; }
    for (const f of listMd(tdPath, cfg.ignore)) {
      const abs = path.resolve(f);
      // session stubs are tracked by SESSIONS_INDEX and exempt from ORPHAN (their coverage is checked separately, as UNINDEXED)
      if (sessionsAbs && (abs === sessionsAbs || abs.startsWith(sessionsAbs + path.sep))) continue;
      if (!referenced.has(abs)) orphans.push(path.relative(root, f).replace(/\\/g, '/'));
    }
  }

  // UNINDEXED — a session file exists on disk but has no line in SESSIONS_INDEX (a class of drift).
  // If SESSIONS_INDEX does not exist the check is skipped (never penalise a project that does not use one).
  const unindexed = [];
  const indexFile = cfg.sessionsIndex ? safeResolve(root, cfg.sessionsIndex, DEFAULTS.sessionsIndex) : null;
  if (sessionsAbs && fs.existsSync(sessionsAbs) && indexFile && fs.existsSync(indexFile)) {
    const idxContent = fs.readFileSync(indexFile, 'utf8');
    for (const f of listMd(sessionsAbs, cfg.ignore)) {
      const base = path.basename(f);
      if (idxContent.indexOf(base) === -1) unindexed.push(path.relative(root, f).replace(/\\/g, '/'));
    }
  }

  const sizeWarn = [];
  for (const idx of cfg.indexes) {
    const idxPath = path.join(root, idx);
    if (!fs.existsSync(idxPath)) continue;
    const buf = fs.readFileSync(idxPath);
    const lines = buf.toString('utf8').split('\n').length;
    if (lines > cfg.sizeLimitLines || buf.length > cfg.sizeLimitBytes) {
      sizeWarn.push(`${idx}: ${lines} lines / ${buf.length}B (limit ${cfg.sizeLimitLines}/${cfg.sizeLimitBytes})`);
    }
  }

  return { root, referenced, broken, orphans, unindexed, sizeWarn };
}

function main() {
  const r = computeIntegrity(ROOT);
  console.log(`DS-ReCall integrity — ${r.root}`);
  console.log(`  referenced=${r.referenced.size}  broken=${r.broken.length}  orphan=${r.orphans.length}  unindexed=${r.unindexed.length}  size-warn=${r.sizeWarn.length}`);
  r.broken.forEach(b => console.log(`  BROKEN     ${b}`));
  r.orphans.forEach(o => console.log(`  ORPHAN     ${o}`));
  r.unindexed.forEach(u => console.log(`  UNINDEXED  ${u}`));
  r.sizeWarn.forEach(s => console.log(`  SIZE       ${s}`));

  const fail = r.broken.length > 0 || r.orphans.length > 0 || r.unindexed.length > 0;
  console.log(`RESULT: ${fail ? 'FAIL' : 'OK'}`);
  process.exit(fail ? 1 : 0);
}

module.exports = { computeIntegrity };

if (require.main === module) main();
