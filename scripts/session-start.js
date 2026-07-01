#!/usr/bin/env node
/*
 * DS-ReCall — SessionStart hook
 * (1) per-session kilit + concurrency tarama
 * (2) oturum stub'ı (idempotent) — opened: damgası ile
 * (3) SESSIONS_INDEX'e RAW satırı (çökmeye dayanıklı) + ESKİ RAW'lar için catch-up dürtüsü
 * (4) Claude'a sistem SAAT/TARİH enjeksiyonu (tarih-halüsinasyon kalkanı)
 * (5) auto-memory KAPALI mı denetimi (ürünün ön-koşulu)
 *
 * Tüm zaman damgaları makine-LOCAL 'YYYY-MM-DD HH:mm'.
 * Input  (stdin JSON): { session_id, cwd, transcript_path, hook_event_name, source }
 * Output (stdout JSON): { hookSpecificOutput: { hookEventName, additionalContext } }
 */
'use strict';
const fs = require('fs');
const path = require('path');

function readStdin() { try { return fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch (_) { return ''; } }
function sanitize(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '-'); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function nowLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

const DEFAULTS = { sessionsDir: 'docs/sessions', staleLockHours: 12, staleDays: 21, nested: true };

// Resolve a config-supplied relative path but refuse to let it escape project root
// (a copied/malformed ds-recall.config.json with e.g. "sessionsDir": "../../outside"
// must not turn SessionStart into an arbitrary-path write). Falls back to `fallbackRel`.
function safeJoin(root, rel, fallbackRel) {
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(root, rel);
  if (resolved === rootAbs || resolved.startsWith(rootAbs + path.sep)) return resolved;
  return path.resolve(root, fallbackRel);
}

// nested awareness: nearest ancestor ABOVE root that has its own CLAUDE.md = parent project
function findParentProject(root) {
  let dir = path.dirname(root), prev = null;
  for (let i = 0; i < 24 && dir && dir !== prev; i++) {
    try { if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) return dir; } catch (_) {}
    prev = dir; dir = path.dirname(dir);
  }
  return null;
}
// 'updated:' / 'LAST UPDATED:' / 'SON GÜNCELLEME:' date from the local index (time-blindness: how old is this memory?)
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
  const t = Date.parse(dateStr + 'T00:00:00'); if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function loadConfig(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  if (fs.existsSync(p)) {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))); } catch (_) {}
  }
  return DEFAULTS;
}

// auto-memory KAPALI mı? settings.json autoMemoryEnabled:false VEYA env → OK. Aksi: emin değiliz → uyar.
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
  const cfg = loadConfig(root);
  const ssid = sanitize(sid);
  const sid8 = ssid.slice(0, 8);
  const ts = nowLocal();
  const day = ts.slice(0, 10);
  const claudeDir = path.join(root, '.claude');
  const activeDir = path.join(claudeDir, 'active');

  fs.mkdirSync(activeDir, { recursive: true });

  // 1) kilit
  const myLock = ssid + '.lock';
  let lockFailed = false;
  try {
    fs.writeFileSync(path.join(activeDir, myLock),
      JSON.stringify({ session_id: sid, cwd: root, opened: ts, source: input.source || null }) + '\n');
  } catch (_) { lockFailed = true; }

  // 1.5) stale-lock GC: SessionEnd kaçırıp bırakamadığı hayalet kilitleri SİL (TTL aşmış olanlar)
  try {
    const cutoff = Date.now() - (cfg.staleLockHours || 12) * 3600 * 1000;
    for (const f of fs.readdirSync(activeDir)) {
      if (!f.endsWith('.lock') || f === myLock) continue;
      let opened = 0;
      try { opened = Date.parse(JSON.parse(fs.readFileSync(path.join(activeDir, f), 'utf8')).opened) || 0; } catch (_) {}
      if (opened && opened < cutoff) { try { fs.unlinkSync(path.join(activeDir, f)); } catch (_) {} }
    }
  } catch (_) {}

  // 2) stub (idempotent — opened: damgalı; resume'da ÜZERİNE YAZMA)
  const stubName = day + '-' + sid8 + '.md';
  const stubRel = (cfg.sessionsDir + '/' + stubName).replace(/\\/g, '/');
  let stubFailed = false;
  try {
    const sessionsDir = safeJoin(root, cfg.sessionsDir, DEFAULTS.sessionsDir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const stubPath = path.join(sessionsDir, stubName);
    if (!fs.existsSync(stubPath)) {
      fs.writeFileSync(stubPath,
        '---\nsession: ' + ssid + '\nopened: ' + ts + '\n---\n'
        + '# Session ' + day + ' · <title at /wrap>\n\n'
        + '## What happened\n<!-- SessionStart opened this (empty). /wrap fills it. Status lives in SESSIONS_INDEX. -->\n\n'
        + '## Decisions (→ DECISIONS.md)\n\n'
        + '## Open threads\n');
    }
  } catch (_) { stubFailed = true; }

  // 3) SESSIONS_INDEX: ESKİ RAW'ları tara (catch-up) + kendi RAW satırını ekle (idempotent)
  const indexFile = path.join(claudeDir, 'SESSIONS_INDEX.md');
  let staleRaw = [];
  let indexFailed = false;
  try {
    if (!fs.existsSync(indexFile)) {
      fs.writeFileSync(indexFile,
        '# DS-ReCall — Sessions Index\n'
        + '> RAW is written at session START; /ds-recall:wrap flips it 🟡 RAW → ✅ CONSOLIDATED.\n\n');
    }
    const idx = fs.readFileSync(indexFile, 'utf8');
    staleRaw = idx.split('\n')
      // status-marker ONLY (🟡 RAW) — bare word "RAW" also shows up in consolidated
      // prose (e.g. "6 RAW + 6 resume stub", "2 RAW: a/b") and must not false-positive.
      .filter(function (l) { return /🟡\s*RAW/.test(l) && l.indexOf(sid8) === -1; })
      .map(function (l) { var m = l.match(/S-([A-Za-z0-9_-]+)/); return m ? m[1] : null; })
      .filter(Boolean);
    if (idx.indexOf('S-' + sid8) === -1) {
      fs.appendFileSync(indexFile, '- S-' + sid8 + ' · ' + ts + ' · 🟡 RAW · ' + stubRel + '\n');
    }
  } catch (_) { indexFailed = true; }

  // 4) concurrency
  let others = [];
  try {
    others = fs.readdirSync(activeDir)
      .filter(function (f) { return f.endsWith('.lock') && f !== myLock; })
      .map(function (f) { return f.replace(/\.lock$/, ''); });
  } catch (_) {}

  // 5) additionalContext: SAAT her zaman + uyarılar (auto-memory / concurrency / catch-up)
  const ctx = ['🕐 System time now: ' + ts + ' (machine local). Treat as authoritative — do not guess the date/time.'];
  if (!autoMemoryOff(root)) {
    ctx.push('⚠ AUTO-MEMORY may be ON. DS-ReCall expects it OFF — set "autoMemoryEnabled": false in .claude/settings.json (or env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1), else uncurated memory runs alongside and drifts.');
  }
  if (others.length > 0) {
    ctx.push('CONCURRENCY: ' + others.length + ' other active session(s) (' + others.join(', ') + '). Avoid writing shared canon (CLAUDE.md, docs/DECISIONS.md); write only your own session file. Consolidate one at a time (/ds-recall:wrap).');
  }
  if (staleRaw.length > 0) {
    ctx.push('UNCONSOLIDATED: ' + staleRaw.length + ' earlier session(s) still RAW (' + staleRaw.join(', ') + '). Run /ds-recall:wrap to consolidate them before they drift.');
  }
  if (lockFailed || stubFailed || indexFailed) {
    const parts = [lockFailed && 'lock', stubFailed && 'session stub', indexFailed && 'SESSIONS_INDEX'].filter(Boolean);
    ctx.push('⚠ WRITE FAILURE: could not write ' + parts.join('/') + ' — check .claude/ exists and is writable. Memory capture may be silently skipped this session.');
  }

  // NESTED: surface the parent project + the up-propagation contract (sub-project sessions feed the parent index)
  if (cfg.nested !== false) {
    const parent = findParentProject(root);
    if (parent) {
      ctx.push('NESTED: sub-project of "' + path.basename(parent) + '" (parent index: ' + path.basename(parent) + '/CLAUDE.md). At /ds-recall:wrap your 1-line dated summary propagates UP to ' + path.basename(parent) + '/.claude/CHILD_FEED.md. Honor the parent’s hard rules; keep this sub-project’s detail here, not in the parent.');
    }
  }

  // TIME-BLINDNESS: flag a stale local index by its own 'updated' date (old/new indistinguishable without dates)
  const upd = indexUpdated(root);
  if (upd) {
    const age = daysSince(upd);
    if (age !== null && age > (cfg.staleDays || 21)) {
      ctx.push('STALE INDEX: this project’s CLAUDE.md says updated ' + upd + ' (' + age + ' days ago). Verify before trusting; refresh "updated:" at /ds-recall:wrap.');
    }
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[DS-ReCall] ' + ctx.join('  |  ') }
  }));
}

main();
