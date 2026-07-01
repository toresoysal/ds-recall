#!/usr/bin/env node
/*
 * DS-ReCall — memory graph data generator (0 LLM token, cross-platform)
 *
 * Parses SESSIONS_INDEX.md into a small graph: one "topic" planet per distinct
 * [Project - Topic - Vol N] filing tag written by /ds-recall:wrap (see commands/wrap.md
 * step 5), plus a single "Needs Wrap" planet aggregating every still-🟡-RAW session —
 * the one actionable hot-spot the whole viz exists to surface. Individual sessions
 * become moons inside their topic's planet, colored by status.
 *
 * Zero-config default: with no extra setup, topics ARE the planets — works for any
 * ds-recall install on day one, no metadata required.
 *
 * Optional enrichment: `ds-recall.config.json` may define a `projects` array —
 *   "projects": [ { "id": "Marketing", "match": ["Pazarlama", "LinkedIn"] }, ... ]
 * Any topic tag listed in a project's `match` rolls up into that project's planet
 * instead of getting its own. A registered project with ZERO matching sessions still
 * appears (dim/"dormant") — seeing "this exists but nothing's landed here yet" is
 * itself useful signal. This is a generic product feature, not project-specific: any
 * ds-recall user can define their own `projects` list; none is required by default.
 *
 * This is intentionally NOT a required multi-project company map (that would need
 * hand-curated metadata per project and wouldn't ship zero-config). The `projects`
 * config is opt-in enrichment on top of the same free session data every install has.
 *
 * Usage (CLI):    node build-memory-graph.js [projectRoot]
 * Usage (module):  const { buildGraph } = require('./build-memory-graph.js'); buildGraph(root)
 * Output: <root>/_memory-graph/graph-data.js  (the viewer template reads this)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

const DEFAULTS = { sessionsIndex: '.claude/SESSIONS_INDEX.md', projects: [] };

// Case-insensitive lookup: does any registered project's `match` list claim this topic?
// Returns the project's `id` (its planet name) or null if unmatched (falls back to the
// topic being its own planet, preserving default zero-config behavior).
function buildProjectMatcher(projects) {
  const byLowerTopic = new Map();
  for (const proj of (projects || [])) {
    if (!proj || !proj.id) continue;
    for (const m of (proj.match || [])) byLowerTopic.set(String(m).toLowerCase(), proj.id);
  }
  return topic => byLowerTopic.get(String(topic || '').toLowerCase()) || null;
}

function loadConfig(root) {
  const p = path.join(root, '.claude', 'ds-recall.config.json');
  if (fs.existsSync(p)) {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))); } catch (_) {}
  }
  return DEFAULTS;
}

// Same containment guard as the other scripts — a config-supplied sessionsIndex must
// not escape project root.
function safeResolve(root, rel, fallbackRel) {
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(root, rel);
  if (resolved === rootAbs || resolved.startsWith(rootAbs + path.sep)) return resolved;
  return path.resolve(root, fallbackRel);
}

const STATUS = { RAW: 'raw', CONSOLIDATED: 'consolidated', CLOSED: 'closed' };

// Pull the first YYYY-MM-DD out of a date field — format varies ("2026-06-25 08:43→09:24",
// "2026-06-17/18", "2026-05-05–08") so a plain prefix slice isn't reliable.
function extractDate(dateStr) {
  const m = String(dateStr || '').match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// Lenient field-scan parser — SESSIONS_INDEX.md lines are '·'-delimited but field
// ORDER varies by era/status (RAW: status·path[·note]; CLOSED: status·reason·path;
// CONSOLIDATED: status·[tag]·path·description) since years of hand-written + hook-
// written lines coexist. Scan for markers instead of assuming a fixed column.
function parseLine(line) {
  // session-index bullet line, id shape varies by era ("S-<hash>", bare "S080"/"S000",
  // or a raw hash like "d47278dd") — don't assume the "S-" prefix, just require the
  // '- <id> · ...' shape AND a recognized status marker further down (checked below).
  if (!/^-\s*\S/.test(line)) return null;
  const fields = line.replace(/^-\s*/, '').split('·').map(f => f.trim());
  if (fields.length < 2) return null;

  const id = fields[0].replace(/^S-/, '');
  const date = fields[1];
  let status = null;
  let tag = null; // { project, topic, vol }
  let sessionPath = null;
  const descParts = [];

  for (let i = 2; i < fields.length; i++) {
    const f = fields[i];
    if (/🟡\s*RAW/.test(f)) { status = STATUS.RAW; continue; }
    if (/✅\s*CONSOLIDATED/.test(f)) { status = STATUS.CONSOLIDATED; continue; }
    if (/⚪\s*CLOSED/.test(f)) { status = STATUS.CLOSED; continue; }
    const tagMatch = f.match(/^\[(.+?)\s*-\s*(.+?)\s*-\s*Vol\s*(\d+)\]$/i);
    if (tagMatch) { tag = { project: tagMatch[1], topic: tagMatch[2], vol: Number(tagMatch[3]) }; continue; }
    if (!sessionPath && /(^|\/)[\w.\-]+\.md$/.test(f)) { sessionPath = f; continue; }
    descParts.push(f);
  }
  if (!status) return null;

  return {
    id, date, status, tag,
    path: sessionPath || null,
    desc: descParts.join(' · ')
  };
}

function buildGraph(root) {
  const cfg = loadConfig(root);
  const indexFile = safeResolve(root, cfg.sessionsIndex, DEFAULTS.sessionsIndex);
  const projectName = path.basename(path.resolve(root));

  const sessions = [];
  if (fs.existsSync(indexFile)) {
    const text = fs.readFileSync(indexFile, 'utf8');
    for (const line of text.split('\n')) {
      const parsed = parseLine(line);
      if (parsed) sessions.push(parsed);
    }
  }

  const total = sessions.length;
  const rawSessions = sessions.filter(s => s.status === STATUS.RAW);
  const consolidated = sessions.filter(s => s.status === STATUS.CONSOLIDATED);
  const closed = sessions.filter(s => s.status === STATUS.CLOSED);

  // one planet per distinct (project, topic) pair among TAGGED sessions (consolidated only —
  // tags are only written at /wrap time per commands/wrap.md step 5) — UNLESS an optional
  // `projects` config entry claims this topic, in which case it rolls up into that
  // project's planet instead (see header comment for the config shape).
  const matchProject = buildProjectMatcher(cfg.projects);
  const byTopic = new Map();
  for (const s of consolidated) {
    if (!s.tag) continue;
    const resolvedId = matchProject(s.tag.topic) || s.tag.topic;
    if (!byTopic.has(resolvedId)) byTopic.set(resolvedId, { project: s.tag.project, topics: new Set(), sessions: [] });
    const bucket = byTopic.get(resolvedId);
    bucket.topics.add(s.tag.topic);
    bucket.sessions.push(s);
  }
  // untagged consolidated sessions (older history, pre-tagging convention) bucket together
  const untaggedConsolidated = consolidated.filter(s => !s.tag);

  let rMax = 480, rMin = 90;
  const topics = Array.from(byTopic.entries())
    .map(([resolvedId, t]) => ({ resolvedId, ...t }))
    .sort((a, b) => b.sessions.length - a.sessions.length);
  const spread = (i, n) => rMin + (n <= 1 ? 0 : (rMax - rMin) * (i / (n - 1)));

  const planets = topics.map((t, i) => ({
    id: t.resolvedId,
    status: 'aktif',
    mem: t.sessions.length,
    R: Math.round(spread(i, topics.length)),
    type: 'rocky',
    note: t.sessions.length + ' consolidated session(s)'
      + (t.topics.size > 1 || !t.topics.has(t.resolvedId)
          ? ' (tagged: ' + Array.from(t.topics).join(', ') + ')'
          : ''),
    tags: [t.project],
    files: t.sessions.slice(0, 6).map(s => (s.path ? path.basename(s.path) : s.id)),
    lastUpdate: (t.sessions[t.sessions.length - 1] || {}).date || '',
    moons: t.sessions.map(s => ({ id: s.id, status: 'consolidated', date: s.date, desc: s.desc, path: s.path, topic: s.tag ? s.tag.topic : null })),
    _dates: new Set(t.sessions.map(s => extractDate(s.date)).filter(Boolean))
  }));

  if (untaggedConsolidated.length > 0) {
    planets.push({
      id: 'Untagged history', status: 'arsiv', mem: untaggedConsolidated.length,
      R: Math.round(rMax * 0.55), type: 'tech',
      note: untaggedConsolidated.length + ' consolidated session(s) predate the topic-tag convention',
      tags: ['history'],
      files: untaggedConsolidated.slice(0, 6).map(s => (s.path ? path.basename(s.path) : s.id)),
      lastUpdate: (untaggedConsolidated[untaggedConsolidated.length - 1] || {}).date || '',
      moons: untaggedConsolidated.map(s => ({ id: s.id, status: 'consolidated', date: s.date, desc: s.desc, path: s.path })),
      _dates: new Set(untaggedConsolidated.map(s => extractDate(s.date)).filter(Boolean))
    });
  }

  // Registered projects (optional `projects` config) with ZERO matching sessions still
  // appear — dim/"dormant" — so it's visible at a glance what's registered but untouched,
  // not just what happened to accumulate activity.
  const seenPlanetIds = new Set(planets.map(p => p.id));
  for (const proj of (cfg.projects || [])) {
    if (!proj || !proj.id || seenPlanetIds.has(proj.id)) continue;
    planets.push({
      id: proj.id, status: 'dormant', mem: 0,
      R: Math.round(rMax * 0.35), type: 'ice',
      note: proj.note || ('registered project — no consolidated sessions yet'),
      tags: ['dormant'],
      files: [], lastUpdate: '', moons: [],
      _dates: new Set()
    });
  }

  // the one planet that matters most: sessions still needing /ds-recall:wrap
  if (rawSessions.length > 0) {
    planets.unshift({
      id: 'Needs Wrap', status: 'raw', mem: rawSessions.length,
      R: Math.round(rMax * 0.75), type: 'rocky', fortress: true,
      note: rawSessions.length + ' session(s) still 🟡 RAW — run /ds-recall:wrap to consolidate',
      tags: ['action-needed'],
      files: rawSessions.slice(0, 6).map(s => (s.path ? path.basename(s.path) : s.id)),
      lastUpdate: (rawSessions[rawSessions.length - 1] || {}).date || '',
      moons: rawSessions.map(s => ({ id: s.id, status: 'raw', date: s.date, desc: s.desc, path: s.path })),
      _dates: new Set(rawSessions.map(s => extractDate(s.date)).filter(Boolean))
    });
  }

  // Bonds ("synapses"): two planets connect if they have sessions on the SAME calendar
  // day — auto-derivable evidence of a real workflow link (you context-switched between
  // these topics that day) without needing any hand-curated relationship metadata.
  const edges = [];
  for (let i = 0; i < planets.length; i++) {
    for (let j = i + 1; j < planets.length; j++) {
      const a = planets[i], b = planets[j];
      const shared = [...(a._dates || [])].filter(d => (b._dates || new Set()).has(d));
      if (shared.length > 0) edges.push({ a: a.id, b: b.id, weight: shared.length, dates: shared.sort() });
    }
  }
  planets.forEach(p => { delete p._dates; }); // internal-only, not part of the shipped data shape

  const out = {
    updated: new Date().toISOString().slice(0, 10),
    generatedBy: 'build-memory-graph.js (native, 0 token)',
    stats: { total, consolidated: consolidated.length, raw: rawSessions.length, closed: closed.length, topics: topics.length, bonds: edges.length, dormant: planets.filter(p => p.status === 'dormant').length },
    core: { id: projectName, status: 'core', mem: total, note: 'DS-ReCall session index', tags: ['ds-recall'] },
    planets,
    edges
  };

  const outDir = path.join(root, '_memory-graph');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'graph-data.js');
  const stamp = new Date().toISOString();
  const header = '// AUTO-GENERATED - build-memory-graph.js - ' + stamp + ' - DO NOT EDIT (source: ' + cfg.sessionsIndex + ')\n';
  fs.writeFileSync(outFile, header + 'window.DS_MEMORY_GRAPH = ' + JSON.stringify(out, null, 2) + ';\n');

  return { outFile, ...out };
}

function main() {
  const r = buildGraph(ROOT);
  console.log('OK graph-data.js written -> ' + r.outFile);
  console.log('  total=' + r.stats.total + ' consolidated=' + r.stats.consolidated + ' raw=' + r.stats.raw + ' closed=' + r.stats.closed + ' topics=' + r.stats.topics + ' bonds=' + r.stats.bonds + ' dormant=' + r.stats.dormant);
  if (r.stats.raw > 0) console.log('  NOTE: ' + r.stats.raw + ' session(s) need /ds-recall:wrap — see the "Needs Wrap" planet');
}

module.exports = { buildGraph };
if (require.main === module) main();
