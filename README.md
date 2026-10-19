# DS-ReCall

<p align="center"><img src="assets/demo-graph-canvas.png" alt="DS-ReCall memory graph — sessions clustered by topic, a red 'Needs Wrap' hot-spot, same-day bonds" width="720"></p>

**A curated, hallucination-resistant, session-aware memory layer for Claude Code.**

Claude Code's built-in auto-memory lets *Claude* decide what to remember. DS-ReCall is for the case where you would rather decide yourself. It turns **off** the uncurated auto-memory and disciplines Claude Code's **native** memory layer (`CLAUDE.md` + `.claude/rules/`) with:

- **status-tagged, dated facts** (✅ verified · ⚠️ assumption · ⛔ outdated · ❓ unknown) and *one fact, one file*,
- a deliberate end-of-session step, **`/ds-recall:wrap`**, that folds what happened into the canon,
- an **integrity check** (broken links, orphaned notes, unindexed sessions) that can block `git commit`,
- **session locks** so parallel sessions don't overwrite each other's shared files.

The hooks make **no model calls** and **no network requests**, have **no dependencies** beyond Node.js, and keep everything in plain Markdown in your own repo.

> **Status: v0.3.0.** Core built and tested (140 self-test cases plus a negative harness that injects real defects and proves the suite goes red). Used daily on the workspace it was built for. It is young software with a single maintainer — field reports and issues are welcome.

---

## Is it for you?

**Good fit** — a shared `CLAUDE.md` across several people or parallel sessions · a client-facing project where *"what did the AI make up?"* must have a real answer · a workflow where you want to know exactly what was kept and what was dropped.

**Not a good fit** — you want memory that just works with zero thought. The automatic tools (Claude Code's own auto-memory, Anthropic's *Remember* plugin, community tools such as claude-mem) are more mature at that, and DS-ReCall does not compete on that axis. The `/ds-recall:wrap` step is the price of curation; it is deliberate friction, not an oversight.

## Install

**Recommended — per project**, so only repositories that opt in get the hooks (Claude Code 2.1.275 or later):

```bash
claude plugin install ds-recall --marketplace toresoysal/ds-recall --scope project
```

Inside a Claude Code session the equivalent is `/plugin install ds-recall --marketplace toresoysal/ds-recall`. Leave out `--scope project` to install for your user account — the hooks then run in **every** project you open (see [guide §2](docs/USER-GUIDE.md#2-install)).

**Try it without installing** (any Claude Code version): `git clone https://github.com/toresoysal/ds-recall` and start Claude Code with `claude --plugin-dir ./ds-recall`.

Installing is the easy half. Each project also needs a **one-time setup**, and since 0.3.0 that is one command, run from your project root (the plugin's files live under `~/.claude/plugins/cache/devsoy/ds-recall/<version>/`):

```bash
node ~/.claude/plugins/cache/devsoy/ds-recall/0.3.0/scripts/init.js                  # macOS / Linux / Git Bash
```

```powershell
node "$env:USERPROFILE\.claude\plugins\cache\devsoy\ds-recall\0.3.0\scripts\init.js"   # Windows PowerShell
```

It creates `CLAUDE.md`, the decision log, the timeline and the config, copies the three helper scripts the commands run, and adds the `.gitignore` lines — **never overwriting a file you already have**. Add `--dry-run` first to see exactly what it would do. It does not switch built-in auto-memory off behind your back: it reports the state, and only `--disable-auto-memory` edits `.claude/settings.json`. Every option: **[user guide §3](docs/USER-GUIDE.md#3-set-up-a-project-once)**.

> **The commit-gate warns by default (0.3.0).** If the repo has a `docs/` folder that your `CLAUDE.md` does not link to, DS-ReCall sees *orphaned* notes and **warns on every `git commit` — it does not block it.** Strict mode is one config line, `"gateCommit": "block"`. 0.1 and 0.2 blocked by default (measured: a fresh install in a repo with an unlinked `docs/` denied every commit); configs that already say `"gateCommit": true` keep blocking. See [troubleshooting](docs/TROUBLESHOOTING.md#my-git-commit-is-blocked).

## The daily loop

1. **Start a session.** `SessionStart` opens a stub for it, injects the real system clock (anti date-hallucination), warns if auto-memory is still on, and tells you if an *earlier* session holds real work that was never wrapped.
2. **Work normally.**
3. **Before you leave, run `/ds-recall:wrap`.** Decisions go to the decision log, the index is refreshed, durable rules go to `.claude/rules/`, the session is marked consolidated, integrity is re-checked, and you get a visible `SEALED` / `NOT SEALED` verdict.
4. **Forgot?** The session still ends safely (transcript backed up, lock released) and the next session tells you what is owed.

## Five building blocks

| | Block | What it does |
|---|---|---|
| 1 | **Capture** | `SessionStart` / `SessionEnd` hooks: per-session stub, lock, `⚪ OPEN → 🟡 RAW → ✅ CONSOLIDATED` status machine, clock injection, auto-memory check, garbage-collection of empty stubs, lossless transcript-backup rotation. |
| 2 | **Consolidate** | `/ds-recall:wrap`. Its mechanical half runs as `wrap-prep.js`, so the model never reads the big index files just to edit one line. |
| 3 | **Validate** (Moat-1) | `validate.js` + a `PreToolUse` **commit-gate** that warns on `git commit` while integrity is FAIL — or **blocks** it in strict mode (`"gateCommit": "block"`). |
| 4 | **Concurrency** (Moat-2) | Per-session locks + a `PreToolUse` **lock-guard** that blocks `Write`/`Edit` to shared canon files while another live session holds a lock. *Not* a sandbox — see [limits](#limits-stated-up-front). |
| 5 | **Visualize** | `/ds-recall:graph` — a zero-config, self-contained Canvas 2D map of your sessions: planets per topic, a red "Needs Wrap" hot-spot, same-day bonds. No CDN, no build step. |

## Commands

| Command | Purpose |
|---|---|
| `/ds-recall:wrap` | Consolidate the current session before you exit. |
| `/ds-recall:status` | Memory health at a glance — auto-memory state, live locks, sessions owed a wrap, integrity, index size, last milestone. Read-only. |
| `/ds-recall:graph` | Open the interactive session graph. |

Helper scripts (run with `node`): `init.js` (project setup and `--upgrade`), `validate.js` (integrity), `wrap-prep.js` (the deterministic half of wrap), `cleanup.js` (one-time backlog cleanup), `build-memory-graph.js`, and the test suites `selftest.js` / `selftest-negative.js`.

## Documentation

| | |
|---|---|
| **[User guide](docs/USER-GUIDE.md)** | install, project setup, the daily loop, status model, guards, nested workspaces, maintenance, upgrade, uninstall, cost & privacy |
| **[Configuration reference](docs/CONFIGURATION.md)** | every `.claude/ds-recall.config.json` key, its default and what reads it |
| **[Troubleshooting](docs/TROUBLESHOOTING.md)** | symptom → cause → fix |
| **[Changelog](CHANGELOG.md)** | what changed, with the measurements behind each fix |

## How it compares

|  | Claude Code's built-in auto-memory | Auto-compression plugins (Remember, claude-mem, …) | DS-ReCall |
|---|---|---|---|
| Who curates | Claude decides what to save | an AI summarises for you | you — or Claude, explicitly, at `/wrap` |
| Cost per session | loads the first 200 lines / 25 KB of `MEMORY.md` | usually a model call per session | **zero** model calls from hooks; ~158 tokens always-on (Claude Code's own estimate, `claude plugin details ds-recall`), ~2.2k tokens when `/wrap` runs — plus whatever your own `CLAUDE.md` and rules weigh |
| When memory outgrows its limit | an explicit error since Claude Code 2.1.210 (earlier: silent truncation) | varies by tool | a visible size warning at `/ds-recall:status` and `/wrap` |
| Multi-session safety | not a headline feature | not a headline feature of the tools we looked at | per-session locks + a commit-gate (warns by default, blocks in strict mode) |
| Search over past sessions | recall of what it saved | usually yes (semantic / full-text) | **none** — the index plus `grep` |
| Setup | none | install | install **plus** a one-command per-project setup (`init.js`) and one explicit step per session |

The built-in auto-memory was the reference point when this project started; it has since stopped truncating silently, so the remaining difference is **curation, not visibility**.

In our own review (September 2026) the tools closest to DS-ReCall in philosophy were [engram](https://github.com/Gentleman-Programming/engram) (local, no LLM calls, deliberate saves, full-text search) and [total-recall](https://github.com/davegoldblatt/total-recall) (markdown, write gates, human promotion). We have not benchmarked them against DS-ReCall; read their READMEs and pick what fits.

## Limits, stated up front

- **No retrieval layer.** There is no semantic or full-text search over past sessions. Recall is the index plus `grep`. This is the largest capability gap against the tools above.
- **The `/wrap` step relies on discipline.** The mechanical half is deterministic; the judgement half (what was decided, what is a rule) is done by the model and is only as good as the session.
- **The lock-guard is a guard against accidents, not a sandbox.** It hooks the `Write` and `Edit` tools; it does not intercept arbitrary shell redirects such as `echo x >> CLAUDE.md`.
- **The commit-gate only warns by default** (since 0.3.0). It cannot protect a project that never sets `"gateCommit": "block"`; the price of the gentler default is that a warning can be ignored.
- **Project-local script copies do not auto-update.** `/wrap` and `/status` run the copies in `.claude/scripts/`; after upgrading the plugin, one command re-syncs them: `node <plugin>/scripts/init.js --upgrade` ([guide §12](docs/USER-GUIDE.md#12-upgrade-and-uninstall)). Nothing reminds you to run it.
- **The warn output has not been seen by a live Claude Code session by us.** It follows the documented hook format and is exercised by our own tests. `node scripts/live-check-gate.js` proves it against your logged-in `claude` (two tiny model calls); we have not been able to run that live half ourselves yet. A result from you — `OK` or `FAIL` — is worth an issue.
- **Tested mainly on one Windows workspace and one Node version** (v22). Cross-platform by construction (plain Node, Unicode- and space-safe paths), but field reports from macOS and Linux are what this project needs.

## Verify your install

The suites run in a throwaway temp workspace and touch nothing of yours:

```bash
node scripts/selftest.js            # 140 cases, prints coverage per group
node scripts/selftest-negative.js   # injects real defects, proves the suite goes red
```

Expected: `RESULT: OK` from both. The negative harness additionally prints one guard as `NOT EXERCISED` with its reason — that is intentional and declared up front, not a failure.

## License

MIT — see [LICENSE](LICENSE).
