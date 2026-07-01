#!/usr/bin/env node
/*
 * DS-ReCall — SessionEnd hook (deterministik güvenlik ağı, best-effort)
 * Transcript yedekler + stub'a kapanış damgası (closed:) yazar + kilidi bırakır.
 * NOT: SESSIONS_INDEX RAW satırı SessionStart'ta yazılır (çökmeye dayanıklı). SessionEnd çökmede
 *      tetiklenmeyebilir → ASIL kapanış + kesin closed damgası /ds-recall:wrap'tedir; bu best-effort.
 *
 * Zaman damgası makine-LOCAL 'YYYY-MM-DD HH:mm'.
 * Input (stdin JSON): { session_id, cwd, transcript_path, hook_event_name, reason }
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

const DEFAULTS = { sessionsDir: 'docs/sessions', propagateToParent: true };

// Same containment guard as session-start.js — a config-supplied sessionsDir must not
// escape project root (e.g. "../../outside" in a copied ds-recall.config.json).
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
function loadConfig(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  if (fs.existsSync(p)) {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))); } catch (_) {}
  }
  return DEFAULTS;
}

function main() {
  let input = {};
  const raw = readStdin();
  if (raw.trim()) { try { input = JSON.parse(raw); } catch (_) {} }

  const sid = input.session_id || ('unknown-' + Date.now());
  const root = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const transcript = input.transcript_path || '';
  const ssid = sanitize(sid);
  const sid8 = ssid.slice(0, 8);
  const cfg = loadConfig(root);

  const claudeDir = path.join(root, '.claude');
  const backupsDir = path.join(claudeDir, 'backups');
  const activeDir = path.join(claudeDir, 'active');
  fs.mkdirSync(backupsDir, { recursive: true });

  // 1) transcript yedekle (varsa)
  if (transcript && fs.existsSync(transcript)) {
    try { fs.copyFileSync(transcript, path.join(backupsDir, ssid + '.jsonl')); } catch (_) {}
  }

  // 2) stub'a kapanış damgası (best-effort; stub'ı sid8 ile bul → gün-farkına dayanıklı)
  try {
    const sessionsDir = safeJoin(root, cfg.sessionsDir, DEFAULTS.sessionsDir);
    if (fs.existsSync(sessionsDir)) {
      const stub = fs.readdirSync(sessionsDir).find(function (f) { return f.endsWith('-' + sid8 + '.md'); });
      if (stub) {
        const sp = path.join(sessionsDir, stub);
        let c = fs.readFileSync(sp, 'utf8');
        if (!/^closed:/m.test(c)) {
          c = c.replace(/^(---\r?\n)/, '$1closed: ' + nowLocal() + '\n');
          fs.writeFileSync(sp, c);
        }
      }
    }
  } catch (_) {}

  // 2.5) up-propagate a 1-line digest to the parent project's child-feed (best-effort placeholder; /wrap writes the real summary)
  if (cfg.propagateToParent !== false) {
    const parent = findParentProject(root);
    if (parent) {
      try {
        const pcDir = path.join(parent, '.claude');
        fs.mkdirSync(pcDir, { recursive: true });
        const feed = path.join(pcDir, 'CHILD_FEED.md');
        if (!fs.existsSync(feed)) {
          fs.writeFileSync(feed,
            '# Child feed — sub-project session digests (append-only)\n'
            + '> 1 line per sub-project session. /ds-recall:wrap writes the meaningful summary; SessionEnd appends a placeholder if wrap did not run.\n\n');
        }
        if (fs.readFileSync(feed, 'utf8').indexOf('S-' + sid8) === -1) {
          fs.appendFileSync(feed, '- ' + path.basename(root) + ' · ' + nowLocal() + ' · S-' + sid8
            + ' · (session ended — detail: ' + path.basename(root) + '/' + cfg.sessionsDir + ')\n');
        }
      } catch (_) {}
    }
  }

  // 3) kilidi bırak
  const lock = path.join(activeDir, ssid + '.lock');
  if (fs.existsSync(lock)) { try { fs.unlinkSync(lock); } catch (_) {} }

  process.stdout.write('{}');
}

main();
