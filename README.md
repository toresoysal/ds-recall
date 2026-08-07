# DS-ReCall

<p align="center"><img src="assets/demo-graph-canvas.png" alt="DS-ReCall memory graph — sessions clustered by topic, a red 'Needs Wrap' hot-spot, same-day bonds" width="720"></p>

**A curated, hallucination-resistant, session-aware memory layer for Claude Code.**

Claude Code's built-in auto-memory accumulates notes *uncurated*. When those notes drift from your hand-written `CLAUDE.md`, Claude picks arbitrarily and starts "making things up." DS-ReCall replaces that: it turns **off** uncurated auto-memory and disciplines Claude Code's **native** memory layer (`CLAUDE.md` + `.claude/rules/`) with status tags, single-source-of-truth, session-end consolidation, integrity validation, and concurrency safety.

Not an AI app — the ground AI runs on. Built on a memory protocol proven over ~6 months / ~100 real sessions.

---

## 🆕 What's new in 0.2 — the catch-up warning was lying, and the wrap was paying for it

v0.1 wrote a session stub **and** a `🟡 RAW` index line on every session start, unconditionally,
and nothing ever removed them. So the catch-up warning counted *index lines* — it was answering
*"has a line been written?"* instead of *"is there work to consolidate?"*

Measured on the workspace this was built for:

| | |
|---|---|
| what the warning said | **59** sessions still unconsolidated |
| stubs with a completely empty body | **58** |
| sessions that actually held work | **1** |
| stub churn | 10-19/day, **75% empty** (255 of 338) |
| `SessionEnd` never fired for | **88 of 338** stubs (26%) |
| transcript backups, no rotation | **1,038.9 MB** |

Closing sessions carefully did nothing, because the litter was created at **start**, not at end.
And the noise hid signal: the new detector surfaced a **7 KB record of a live customer fix** that
an earlier manual cleanup had mislabelled "empty stub". A gate that is wrong 98% of the time
teaches you to skip the 2% that matters.

**0.2 fixes the measurement, not the volume of the alarm:**

- a real status machine — `⚪ OPEN` (never warns) → `🟡 RAW` (only when the file has content)
  → `✅ CONSOLIDATED`. *"A session existed"* and *"a session produced work"* are now different facts.
- the hook that creates a record now **retracts** it when the record turns out empty
- `/wrap`'s mechanical half moved into `wrap-prep.js` — it used to cost **~41,400 tokens** of
  forced index reading to flip one status line
- backups rotate with **verify-then-delete**, lossless by default
- a self-test that reports **coverage**, and a negative harness that injects real defects and
  proves the suite goes red — it found **two blind arms** on its first run

Full detail: **[CHANGELOG.md](CHANGELOG.md)**

---

## Why

| | Built-in auto-memory | DS-ReCall |
|---|---|---|
| Who curates | nobody (Claude writes freely) | you + discipline |
| Drift control | none | status tags + single source + integrity check |
| Multi-session | clobbering risk | per-session locks + write guard |

"A hook that writes files" is not a moat — many exist. DS-ReCall's edge is **discipline**: status tags (✅ / ⚠️ / ⛔ / ❓) + one-fact-one-file + brain-model consolidation + session-aware concurrency.

### Where this fits next to the other memory plugins

Claude Code's memory space is genuinely crowded now — the built-in auto-memory (`MEMORY.md`, shipped since Claude Code v2.1.59), Anthropic's own official **Remember** plugin, and community tools like **claude-mem** and **memsearch** all solve "automatic, zero-friction recall" well, some at real scale (claude-mem has tens of thousands of GitHub stars at time of writing). DS-ReCall does not compete on that axis and won't pretend to.

|  | Auto-compression (Remember, claude-mem) | DS-ReCall |
|---|---|---|
| Curation | AI summarizes/compresses for you | you (or Claude, explicitly, at `/wrap`) decide what's canon |
| Cost/latency per session | a model call (Remember: <$0.01/session; similar order for others) | **zero** — hooks are plain Node.js, no model call, ever |
| Failure mode when memory grows too big | commonly reported as **silent** truncation of the oldest entries — nothing tells you it happened | a visible size-warning (`sizeLimitLines`/`sizeLimitBytes`) at every `/ds-recall:status` and `/wrap` |
| Multi-session / multi-person safety | not a headline feature of the tools we looked at | per-session locks + a commit-gate that **blocks `git commit` while integrity is failing** |
| Setup cost | zero (fully automatic) | one explicit step per session (`/ds-recall:wrap`) — this is real, deliberate friction, not an oversight |

**Honest bottom line:** if you want memory that just works with zero thought, the automatic tools are more mature and you should use them. DS-ReCall is for the case where you (or your team) specifically don't want an AI silently deciding what to remember and what to drop — a shared `CLAUDE.md` across multiple people/sessions, a client-facing project where "what did the AI make up" has to have a real answer, or a workflow where you'd rather know exactly what got dropped than have it happen invisibly. The `/wrap` step is the price of that — we're not hiding it.

## How it works

DS-ReCall doesn't reinvent storage — Claude Code already loads `CLAUDE.md` and `.claude/rules/` natively every session. DS-ReCall switches off the *uncurated* auto-memory and curates that native layer instead:

| Layer | Native home |
|---|---|
| Lean index | `CLAUDE.md` (loaded in full every session) |
| Durable rules | `.claude/rules/*.md` |
| Episodic detail | `docs/` + session logs |
| Uncurated auto-memory | **OFF** |

## Four building blocks

1. **Capture** — `SessionStart` opens a per-session stub (`docs/sessions/<date>-<id>.md`, one per session id — resuming reuses it), writes an `⚪ OPEN` line to `SESSIONS_INDEX.md`, sweeps stubs abandoned by sessions that died without `SessionEnd`, and nudges you only if an *earlier* session **holds real work** and hasn't been wrapped. `SessionEnd` backs up the transcript, rotates old backups, and then decides what the session actually was: empty → the stub and its index line are **retracted**; has content → `closed:` stamp and the line is promoted to `🟡 RAW`. It also injects the current system clock (anti date-hallucination) and warns if auto-memory isn't disabled.
2. **Consolidate** — `/ds-recall:wrap`: melt the session into the canon (decisions → log, index refresh, rules → `.claude/rules/`), status-tagged. Its mechanical half runs as `wrap-prep.js` so the model never has to read the big index files just to edit one line.
3. **Validate (Moat-1)** — integrity check: broken-link / orphan / unindexed-session / size. A `PreToolUse` **commit-gate** runs it automatically on every `git commit` and **blocks the commit while integrity is FAIL** — so consistency depends on the system, not on you remembering `/wrap` (bypass once with `gateCommit:false`).
4. **Concurrency (Moat-2)** — per-session locks + a `PreToolUse` guard that blocks clobbering writes to shared canon while other sessions are live. Stale locks expire on a TTL and are swept at the next `SessionStart`. **Caveat:** the guard hooks the `Write`/`Edit` tools; it does not (and cannot, in general) intercept arbitrary `Bash` redirects into a protected file (e.g. `echo x >> CLAUDE.md`). Treat it as a strong guard against accidental clobbering, not a hard sandbox against a deliberately adversarial agent.
5. **Visualize** — `/ds-recall:graph` turns `SESSIONS_INDEX.md` into a zero-config Canvas 2D graph: sessions cluster into planets by their `[Project - Topic - Vol N]` filing tag, and every still-unconsolidated session surfaces on one always-visible "Needs Wrap" hot-spot — click it to see exactly what needs `/ds-recall:wrap`. Every session is also independently hoverable/clickable, with an auto-opening quick-look card and a persistent bottom info bar; topics worked on the same calendar day connect with an animated bond (auto-derived, no curation). Optionally group topics under named projects/departments via config (`projects`, see below) — dormant ones (registered, zero sessions) still show up instead of silently vanishing. Unlike a static note-graph (e.g. Obsidian), it's color-coded by curation status, not just link structure. Self-contained HTML, no CDN, no build step; regenerate the data any time with `node scripts/build-memory-graph.js`.

## Install

1. Load the plugin. Local dev: `claude --plugin-dir ./ds-recall` (validate with `claude plugin validate ./ds-recall`).
2. Turn off built-in auto-memory: `"autoMemoryEnabled": false` in your project `.claude/settings.json` (or env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). If you forget, `SessionStart` re-checks this every session and injects a visible warning until it's off — you won't silently run both memory layers at once.
3. Copy templates into your project:
   - `templates/CLAUDE.md` → `./CLAUDE.md`
   - `templates/DECISIONS.md` → `./docs/DECISIONS.md`
   - `templates/ds-recall.config.json` → `./.claude/ds-recall.config.json`
   - `templates/rule-example.md` → `./.claude/rules/<topic>.md`
   - `scripts/validate.js` → `./.claude/scripts/validate.js` (so `/ds-recall:wrap` can run the integrity gate; command bodies don't expand `${CLAUDE_PLUGIN_ROOT}`)
   - `scripts/wrap-prep.js` **and** `scripts/session-lib.js` → `./.claude/scripts/` (0.2+ — `/ds-recall:wrap` step 0 calls it; it requires `session-lib.js` from the same folder)
4. Add `.claude/active/`, `.claude/backups/`, and `_memory-graph/` to your `.gitignore` (the graph is regenerated on demand; `graph.html` is a static copy, not worth diffing).
5. **Verify the install actually works** (0.2+) — the suites run in a throwaway temp workspace and touch nothing of yours:
   ```bash
   node scripts/selftest.js            # 59 cases, prints coverage per group
   node scripts/selftest-negative.js   # injects real defects, proves the suite goes red
   ```

## Commands

- `/ds-recall:wrap` — consolidate the current session before you exit.
- `/ds-recall:status` — memory health at a glance (auto-memory state, active/RAW sessions, integrity, index size, last milestone). Read-only.
- `/ds-recall:graph` — visualize sessions as an interactive graph, clustered by topic tag, with a one-click "Needs Wrap" hot-spot.

## Config — `.claude/ds-recall.config.json`

| Key | Meaning | Default |
|---|---|---|
| `indexes` | files scanned as the reference source | `["CLAUDE.md"]` |
| `tracked` | dirs scanned for orphan files | `["docs"]` |
| `protected` | files the write-guard locks | `["CLAUDE.md","DECISIONS.md","SESSIONS_INDEX.md"]` |
| `sizeLimitLines` / `sizeLimitBytes` | index size warning | `200` / `25600` |
| `sessionsIndex` | session-coverage reference (UNINDEXED check) | `.claude/SESSIONS_INDEX.md` |
| `staleLockHours` | dead-lock expiry + `SessionStart` GC | `12` |
| `gateCommit` | block `git commit` while integrity is FAIL | `true` |
| `projects` | optional: roll topic tags up under named projects for `/ds-recall:graph` (see below) | `[]` |
| **`gcEmptyStubs`** | collect stubs abandoned by sessions that died without `SessionEnd` | `true` |
| **`backupCompressDays`** | gzip transcript backups older than N days (`0` = off) | `14` |
| **`backupCompressPerRun`** | cap per hook run, so a big backlog can't stall `SessionEnd` | `5` |
| **`backupDeleteDays`** | hard-delete `.gz` older than N days. **`0` = never delete** — the default is lossless | `0` |
| **`maxIndexLineChars`** | truncate `--flip --summary`; keeps the machine index status-only (`0` = no limit) | `0` |
| **`neverTouch`** | extra filename patterns `cleanup.js` must refuse (your vault/secret dirs) — added on top of the built-in `.env`/`token`/`secret`/`credential`/`.pem`/`.key` floor | `[]` |
| **`evict`** | mechanical root-index line cap: `{file, linePattern, maxLines, targetFile, targetAnchor}` | see CHANGELOG |

### Grouping topics into projects (optional, for `/ds-recall:graph`)

By default the memory graph makes one planet per `[Project - Topic - Vol N]` tag — works zero-config for any install. If your work spans real sub-projects or departments that don't map 1:1 onto topic tags (a marketing department that shows up in the index as `LinkedIn`, `Pazarlama`, `Web Tasarım`...), define `projects` to merge them and to surface departments that exist but haven't accumulated any sessions yet (shown dim/"registered, no activity yet" instead of silently missing):

```json
"projects": [
  { "id": "Marketing", "match": ["Pazarlama", "LinkedIn", "Web Tasarım"] },
  { "id": "Corporate Identity", "match": ["Kurumsal"], "note": "brand/identity work — dormant until a session tags it" }
]
```
Any topic not listed in a `match` array still gets its own planet exactly as before — this is additive enrichment, never required.

### Avoiding false orphans (sub-indexes)

The validator flags a tracked `.md` as `ORPHAN` only if no `indexes` file references it. For a folder of peer docs (e.g. `docs/research/01…09.md`), don't bloat `CLAUDE.md` with nine links — point it at a **sub-index** and list that in `indexes`:

```json
"indexes": ["CLAUDE.md", "docs/research/README.md"]
```

References resolve relative to each index's own folder, so the sub-index's links cover everything under it. Hierarchical index, lean root, zero false orphans.

## Status

**v0.1 — core built and unit-tested** (validation, session lifecycle, consolidation, concurrency). Cross-platform (Node), Unicode-path safe. Real-hook integration tests in progress. Not yet published; dogfooding first.

## License

MIT
