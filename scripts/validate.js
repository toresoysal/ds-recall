#!/usr/bin/env node
/*
 * DS-ReCall — memory integrity validator
 * Köken protokol Bölüm 12 (orphan/broken/boyut) genelleştirilmiş, cross-platform hali.
 *
 * Kontroller:
 *   BROKEN     — index dosyalarındaki .md referansı diskte yok (ölü link)
 *   ORPHAN     — izlenen dizindeki .md dosyası hiçbir index'ten referanslı değil (kayıp risk)
 *   UNINDEXED  — sessionsDir'deki session dosyası SESSIONS_INDEX'te yok (= B1 drift sınıfı)
 *   SIZE       — index dosyası satır/byte eşiğini aştı (sadece uyarı, fail değil)
 *
 * Çıkış kodu: 0 = temiz, 1 = broken/orphan/unindexed bulundu (gate-commit / CI için).
 * Kullanım (CLI): node validate.js [projectRoot]   (yoksa CLAUDE_PROJECT_DIR ya da cwd)
 * Kullanım (modül): const { computeIntegrity } = require('./validate.js'); computeIntegrity(root)
 * Config (opsiyonel): <root>/.claude/ds-recall.config.json  → DEFAULTS'u override eder.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

const DEFAULTS = {
  indexes: ['CLAUDE.md'],                 // referans KAYNAĞI (root-relative). Alt-indeks de eklenebilir, ör. 'docs/research/README.md'
  tracked: ['docs'],                      // orphan için taranan dizinler (root-relative)
  sessionsDir: 'docs/sessions',           // oto-stub dizini → orphan-muaf (SESSIONS_INDEX izler)
  sessionsIndex: '.claude/SESSIONS_INDEX.md', // session kapsam denetiminin referansı
  sizeLimitLines: 200,                    // index satır uyarı eşiği
  sizeLimitBytes: 25 * 1024,              // index byte uyarı eşiği (auto-memory ~25KB native sınırı)
  ignore: ['node_modules', '.git', 'ilk-taslaklar'] // taranmayacak isimler
};

function loadConfig(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  if (fs.existsSync(p)) {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))); }
    catch (e) { console.error(`! config parse hatasi (${p}), varsayilan kullaniliyor: ${e.message}`); }
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

// Bir markdown metnindeki yerel .md referanslarini cikar.
// 1) [text](path.md) markdown linkleri  2) `backtick` icindeki yollar  3) SADECE '/' iceren duz yollar.
// Ciplak dosya-adi mention'lari (MEMORY.md gibi aciklamalar) KASTEN haric — false-positive broken olmasin.
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

  // 2) `backtick` icindeki yollar — boslukLU klasor adlari burada yasar.
  //    Backtick sinir oldugu icin bosluga izin vermek prose'u yutmaz.
  //    Spanlar ayni anda metinden CIKARILIR ki adim 3 onlari tekrar gormesin.
  const ticked = [];
  const stripped = content.replace(/`([^`\n]+)`/g, (_whole, inner) => {
    ticked.push(inner);
    return ' ';
  });
  for (const t of ticked) {
    const s = t.trim();
    if (/\.md$/i.test(s) && s.includes('/') && !/[<>|*?]/.test(s)) add(s);
  }

  // 3) Ciplak yollar (backtick disi, bosluksuz) — eski davranis birebir korunur.
  for (const m of stripped.matchAll(/(?:^|[\s("'])((?:\.{0,2}\/)?[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.md)/gm)) add(m[1]);

  return refs;
}

// Bir dizindeki tum .md dosyalarini recursive listele (ignore haric).
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

// Bütünlük hesabı — saf (yan etkisiz, process.exit yok). CLI ve commit-gate hook'u aynı fonksiyonu kullanır.
function computeIntegrity(root) {
  const cfg = loadConfig(root);
  const referenced = new Set();   // mutlak path
  const broken = [];

  for (const idx of cfg.indexes) {
    const idxPath = path.resolve(root, idx);
    if (!isContained(root, idxPath)) { console.error(`! index disi konum reddedildi (config kacagi): ${idx}`); continue; }
    if (!fs.existsSync(idxPath)) { console.error(`! index bulunamadi: ${idx}`); continue; }
    const content = fs.readFileSync(idxPath, 'utf8');
    for (const ref of extractRefs(content)) {
      // Referans, içinde geçtiği index dosyasının klasörüne göre çözülür → alt-indeks (docs/research/README.md) doğal çalışır.
      const target = path.resolve(path.dirname(idxPath), ref);
      referenced.add(target);
      // .claude/ altı runtime/config (SESSIONS_INDEX vb.) bütünlük kapsamı dışı — oturumda oluşur
      const isRuntime = /(^|\/)\.claude\//.test(ref.replace(/\\/g, '/'));
      if (!fs.existsSync(target) && !isRuntime) broken.push(`${idx} -> ${ref}`);
    }
  }

  const orphans = [];
  const sessionsAbs = cfg.sessionsDir ? safeResolve(root, cfg.sessionsDir, DEFAULTS.sessionsDir) : null;
  for (const td of cfg.tracked) {
    const tdPath = path.resolve(root, td);
    if (!isContained(root, tdPath)) { console.error(`! tracked disi konum reddedildi (config kacagi): ${td}`); continue; }
    for (const f of listMd(tdPath, cfg.ignore)) {
      const abs = path.resolve(f);
      // session stub'ları SESSIONS_INDEX tarafından izlenir; orphan kapsamı dışı (kapsamları ayrıca UNINDEXED ile denetlenir)
      if (sessionsAbs && (abs === sessionsAbs || abs.startsWith(sessionsAbs + path.sep))) continue;
      if (!referenced.has(abs)) orphans.push(path.relative(root, f).replace(/\\/g, '/'));
    }
  }

  // UNINDEXED — diskte session dosyası var ama SESSIONS_INDEX'te satırı yok (B1 drift sınıfı).
  // SESSIONS_INDEX yoksa kontrol atlanır (kırılmaz — index kullanmayan projeyi cezalandırma).
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
      sizeWarn.push(`${idx}: ${lines} satir / ${buf.length}B (limit ${cfg.sizeLimitLines}/${cfg.sizeLimitBytes})`);
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
