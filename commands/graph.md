---
description: Visualize this project's memory as an interactive graph — sessions cluster by topic, RAW ones surface as a "Needs Wrap" hot-spot you can click straight into. Triggers on "show my memory graph", "visualize my sessions", "memory map".
allowed-tools: ["Read", "Write", "Bash"]
---

# /ds-recall:graph — Memory Graph

Renders `SESSIONS_INDEX.md` as a self-contained, zero-config visual: one planet per topic tag (`[Project - Topic - Vol N]`, written by `/ds-recall:wrap`), one moon per session colored by status, and a single always-visible "Needs Wrap" planet aggregating every still-🟡-RAW session — click it to see exactly what needs `/ds-recall:wrap` and why.

Every session is independently hoverable/clickable too, not just via its planet: hovering anything (planet or single session) auto-opens a quick-look card near the cursor and updates a persistent bottom info bar; clicking opens the full detail panel. Topics that had sessions on the **same calendar day** connect with an animated bond ("worked on X and Y that day") — auto-derived from the dates already in the index, no manual curation.

This is deliberately **not** a hand-curated multi-project company map (that needs manual metadata per project and won't work zero-config for a fresh install). It visualizes the one thing every ds-recall project already has for free.

## 1. Generate fresh data (0 LLM token)
```
node <plugin-root>/ds-recall/scripts/build-memory-graph.js .
```
This reads `.claude/SESSIONS_INDEX.md` (or the path in `ds-recall.config.json`'s `sessionsIndex`) and writes `_memory-graph/graph-data.js` in the project root. Re-run this any time the index changes — it's pure parsing, no model call.

## 2. Ensure the viewer exists (one-time per project)
If `_memory-graph/graph.html` doesn't exist yet, copy it from the plugin:
```
<plugin-root>/ds-recall/assets/memory-graph.html  →  _memory-graph/graph.html
```
It's a static, self-contained Canvas 2D page (no CDN, no build step) that reads the sibling `graph-data.js`. Never regenerate `graph.html` itself once a project has customized it — only `graph-data.js` changes on each run.

## 3. Show it
The file opens automatically in the Launch preview panel after Write/Edit. Tell the user the path and that opening it directly in a browser gives the full experience (the preview panel's embedded browser can time out screenshotting the animation loop — that's a tooling quirk, not a sign anything is broken; use `preview_eval` to inspect state if you need to verify it, not `preview_screenshot`).

## Rule
Don't show stale data — always regenerate `graph-data.js` first (step 1) before opening/reopening the viewer. If `SESSIONS_INDEX.md` doesn't exist yet (no sessions recorded), say so — don't fabricate placeholder sessions.
