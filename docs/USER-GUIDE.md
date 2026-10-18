# DS-ReCall user guide

> Applies to **v0.2.1** · written 2026-10-18 · every command and output below was run, not recalled. Where something is an estimate or was not tested, it says so.

**Contents**
[1. What it is](#1-what-it-is) ·
[2. Install](#2-install) ·
[3. Set up a project (once)](#3-set-up-a-project-once) ·
[4. Adopting it in a repo that already has docs](#4-adopting-it-in-a-repo-that-already-has-docs) ·
[5. Your first session](#5-your-first-session) ·
[6. The daily loop: `/ds-recall:wrap`](#6-the-daily-loop-ds-recallwrap) ·
[7. Session status model](#7-session-status-model) ·
[8. The two guards](#8-the-two-guards) ·
[9. Several projects: nested workspaces](#9-several-projects-nested-workspaces) ·
[10. The memory graph](#10-the-memory-graph) ·
[11. Maintenance](#11-maintenance) ·
[12. Upgrade and uninstall](#12-upgrade-and-uninstall) ·
[13. What it costs and what it touches](#13-what-it-costs-and-what-it-touches) ·
[14. Limits](#14-limits)

Companion documents: [Configuration reference](CONFIGURATION.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Changelog](../CHANGELOG.md)

---

## 1. What it is

Claude Code already loads two things natively at the start of every session: your `CLAUDE.md` and everything in `.claude/rules/`. DS-ReCall does not invent a new storage layer. It **turns off Claude Code's uncurated auto-memory** and **disciplines those native files**.

| Layer | Where it lives | Loaded |
|---|---|---|
| Lean index | `CLAUDE.md` | in full, every session |
| Durable rules | `.claude/rules/*.md` | every session (or only for matching files if a rule declares `paths:`) |
| Episodic detail | `docs/` (decisions, timeline, session notes) | on demand |
| Uncurated auto-memory | — | **off** |

On top of that sit five mechanisms: **capture** (hooks that record each session), **consolidate** (`/ds-recall:wrap`), **validate** (integrity check + commit-gate), **concurrency** (locks + lock-guard) and **visualize** (`/ds-recall:graph`).

The core idea is a **status discipline**: every fact carries a tag and a date, so old, new and parallel information can be told apart.

| Tag | Meaning |
|---|---|
| ✅ | verified |
| ⚠️ | assumption |
| ⛔ | outdated (kept, never silently overwritten) |
| ❓ | unknown — verify, don't invent |

*"Hallucination-resistant" means:* unverified claims are visibly marked, shared facts live in one place, and a check catches dead links and orphaned notes. It does **not** mean Claude can no longer be wrong.

## 2. Install

**Requirements:** Claude Code (2.1.275+ for the one-line install below; any version works with `--plugin-dir`) and Node.js on your `PATH` (tested on v22; no npm packages are used). Hooks run as plain `node` commands.

### Recommended: per-project install

```bash
claude plugin install ds-recall --marketplace toresoysal/ds-recall --scope project
```

This adds the marketplace (to your user settings) if needed and enables the plugin **only in the current project** by writing to that project's `.claude/settings.json`:

```json
{ "enabledPlugins": { "ds-recall@devsoy": true } }
```

Teammates run the same command (the marketplace declaration lives in each person's own user settings). Inside a Claude Code session the equivalent is `/plugin install ds-recall --marketplace toresoysal/ds-recall`.

### User-wide install

Leave out `--scope project`. **Know what that means:** the `SessionStart` and `SessionEnd` hooks then run in *every* project you open, including ones you never set up — they will create `.claude/active/`, a `docs/sessions/` stub, an index file and a transcript backup there (empty stubs are retracted at session end, but the backup is not). Prefer the per-project install unless you want exactly that.

### Try it without installing

```bash
git clone https://github.com/toresoysal/ds-recall
claude --plugin-dir ./ds-recall      # loads the plugin for this run only
```

`claude plugin validate ./ds-recall` validates the manifest.

### Verify the install

```bash
node scripts/selftest.js            # 59 cases, coverage per group      → RESULT: OK
node scripts/selftest-negative.js   # injects real defects, expects red → RESULT: OK
```

Both run in a throwaway temp workspace. Expect the negative harness to list **one** guard as `NOT EXERCISED` — it is declared up front with its reason and is not a failure. (On 0.2.0 the negative harness reported `RESULT: FAIL` on Windows checkouts where git had converted files to CRLF; fixed in 0.2.1.)

Installed plugin files live under `~/.claude/plugins/cache/devsoy/ds-recall/<version>/` (on Windows `%USERPROFILE%\.claude\plugins\cache\devsoy\ds-recall\<version>\`). You will copy a few of them in the next step.

## 3. Set up a project (once)

Installing the plugin gives you the hooks and commands. Each project additionally needs its own index, config and three helper scripts. **The commands call the project-local copies** (`node .claude/scripts/...`), because command bodies are prompts, not shells, and `${CLAUDE_PLUGIN_ROOT}` was not expanded inside them when 0.1 was built (not re-verified on 2.1.299 — if a future Claude Code expands it, this copy step can go away).

Run from your **project root**. `cp -n` / `Test-Path` never overwrite a file you already have.

**macOS / Linux / Git Bash**

```bash
DSR=~/.claude/plugins/cache/devsoy/ds-recall/0.2.1   # adjust the version; or point at your clone
mkdir -p .claude/scripts .claude/rules docs
cp -n "$DSR/templates/CLAUDE.md"             ./CLAUDE.md
cp -n "$DSR/templates/DECISIONS.md"          ./docs/DECISIONS.md
cp -n "$DSR/templates/TIMELINE.md"           ./docs/TIMELINE.md
cp -n "$DSR/templates/ds-recall.config.json" ./.claude/ds-recall.config.json
cp -n "$DSR/scripts/validate.js" "$DSR/scripts/wrap-prep.js" "$DSR/scripts/session-lib.js" ./.claude/scripts/
printf '\n# DS-ReCall runtime (backups hold full session transcripts - never commit them)\n.claude/active/\n.claude/backups/\n.claude/.index.lock\n_memory-graph/\n' >> .gitignore
```

**Windows PowerShell**

```powershell
$DSR = "$env:USERPROFILE\.claude\plugins\cache\devsoy\ds-recall\0.2.1"   # adjust the version
New-Item -ItemType Directory -Force .claude\scripts, .claude\rules, docs | Out-Null
$copy = @(
  @('templates\CLAUDE.md',             'CLAUDE.md'),
  @('templates\DECISIONS.md',          'docs\DECISIONS.md'),
  @('templates\TIMELINE.md',           'docs\TIMELINE.md'),
  @('templates\ds-recall.config.json', '.claude\ds-recall.config.json'),
  @('scripts\validate.js',             '.claude\scripts\validate.js'),
  @('scripts\wrap-prep.js',            '.claude\scripts\wrap-prep.js'),
  @('scripts\session-lib.js',          '.claude\scripts\session-lib.js')
)
foreach ($c in $copy) { if (-not (Test-Path $c[1])) { Copy-Item (Join-Path $DSR $c[0]) $c[1] } }
@"

# DS-ReCall runtime (backups hold full session transcripts - never commit them)
.claude/active/
.claude/backups/
.claude/.index.lock
_memory-graph/
"@ | Add-Content -Encoding ascii .gitignore
```

> `wrap-prep.js` requires `session-lib.js` from the same folder, and `/ds-recall:wrap` calls `wrap-prep.js` — copy all three.

> ⚠️ **Already have your own `CLAUDE.md`?** The block keeps it (nothing is overwritten) — but the copied `docs/DECISIONS.md` and `docs/TIMELINE.md` are then **orphans** until your `CLAUDE.md` points at them, and the commit-gate will block `git commit`. Measured: `orphan=2`. Fix it by adding two lines to your `CLAUDE.md`:
> ```
> - Decisions (dated, reasoned) -> docs/DECISIONS.md
> - Milestones -> docs/TIMELINE.md
> ```
> Plain paths are enough; markdown link syntax is not required. (Measured after adding them: `orphan=0`, `RESULT: OK`.) More in [§4](#4-adopting-it-in-a-repo-that-already-has-docs).

**Then, by hand (two things a script should not decide for you):**

1. **Turn built-in auto-memory off** for this project. In `.claude/settings.json` add (merge with what is there):
   ```json
   { "autoMemoryEnabled": false }
   ```
   or set the environment variable `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. If you forget, `SessionStart` re-checks every session and injects a visible warning until it is off, so you never silently run both memory layers.
2. **Fill in `CLAUDE.md`.** Replace the `<placeholders>`: project name, a one-paragraph summary, your hard rules. Keep it an **index** — point to detail files, never paste detail in.

**What you now have**

| File | Role |
|---|---|
| `CLAUDE.md` | the lean index (the "hippocampus"), loaded every session |
| `docs/DECISIONS.md` | dated, reasoned decision log — single source of truth for decisions |
| `docs/TIMELINE.md` | real milestones only (not every session) |
| `.claude/ds-recall.config.json` | settings — see the [configuration reference](CONFIGURATION.md) |
| `.claude/scripts/*.js` | the three project-local helper scripts |
| `.claude/rules/*.md` | durable "always / never" rules; copy `templates/rule-example.md` as a starting point |

**Check it:**

```bash
node .claude/scripts/validate.js
```

```
DS-ReCall integrity — <your project>
  referenced=2  broken=0  orphan=0  unindexed=0  size-warn=0
RESULT: OK
```

Exit code `0` = clean, `1` = broken/orphan/unindexed found. Size warnings are advisory and never fail.

## 4. Adopting it in a repo that already has docs

This is the case that surprises people, so read it before enabling the plugin on an existing repo.

The validator scans the directories in `tracked` (default `["docs"]`) for Markdown files and expects at least one **index file** (default `CLAUDE.md`) to reference each. A note that nothing references is an **ORPHAN**, and **while orphans, broken links or unindexed sessions exist the commit-gate blocks `git commit`**.

Measured on a fresh install (a repo with `docs/foo.md`, no `CLAUDE.md`, no config):

```
Commit blocked — memory integrity FAIL: 0 broken, 1 orphan, 0 unindexed session(s).
```

Your options, from least to most invasive:

1. **Don't gate yet.** Set `"gateCommit": false` in `.claude/ds-recall.config.json`, adopt the rest, turn it on later.
2. **Link what you have.** Add a *WHERE THINGS ARE* list to `CLAUDE.md` that references each note — or create a **sub-index** (e.g. `docs/research/README.md`) that links a whole folder, and list it in `indexes`:
   ```json
   "indexes": ["CLAUDE.md", "docs/research/README.md"]
   ```
   References resolve relative to each index file's own folder, so one sub-index covers everything under it without bloating the root.
3. **Narrow the scan.** Change `tracked` to the folders you actually want curated.

Already have a `CLAUDE.md`? Don't overwrite it: keep yours, and add the status-tag convention (✅/⚠️/⛔/❓ plus a date) and a *WHERE THINGS ARE* section.

Paths containing spaces or non-ASCII characters are handled (a fix from 2026-08-02 is part of 0.2).

## 5. Your first session

Start Claude Code in the project. `SessionStart` runs silently and injects one line of context into the model, which looks like this (real output):

```
[DS-ReCall] 🕐 System time now: 2026-10-18 18:28 (machine local). Treat as authoritative — do not guess the date/time.
  |  ⚠ AUTO-MEMORY may be ON. DS-ReCall expects it OFF — set "autoMemoryEnabled": false in .claude/settings.json …
```

It also writes, in your project:

- `.claude/active/<session-id>.lock` — your live-session lock,
- `docs/sessions/<date>-<id8>.md` — an **empty stub** for this session (one per session id; resuming reuses it),
- a line in `.claude/SESSIONS_INDEX.md`: `- S-<id8> · <time> · ⚪ OPEN · docs/sessions/<file>`.

Further context lines appear only when relevant:

| Message | Meaning |
|---|---|
| `CONCURRENCY: N other active session(s)…` | another session is live in this project — avoid editing shared canon |
| `UNCONSOLIDATED WORK: N earlier session(s) have content but no /ds-recall:wrap (…)` | sessions with **real content** that were never wrapped |
| `GC: collected N abandoned empty stub(s)…` | leftovers of crashed sessions were cleaned up |
| `NESTED: sub-project of "<parent>"…` | see [§9](#9-several-projects-nested-workspaces) |
| `STALE INDEX: … updated <date> (N days ago)` | your `CLAUDE.md` says `updated:` more than `staleDays` ago |
| `⚠ WRITE FAILURE: could not write …` | `.claude/` is missing or read-only — capture may be skipped this session |

## 6. The daily loop: `/ds-recall:wrap`

Work normally. When you are done, run **`/ds-recall:wrap`**. It is a model-driven command with a deterministic first step:

| Step | What happens |
|---|---|
| **0** | `node .claude/scripts/wrap-prep.js . --gc` prints a ~40-line briefing: this session's stub and status, sessions that genuinely still need consolidating, the root-index line cap, per-session fixed load, integrity. The model is told **not** to open the big index files — the script already read them. |
| 1 | Review what actually happened. |
| 2 | Append **permanent decisions** to `docs/DECISIONS.md`. A reversed decision marks the old entry ⛔ and **adds** a new one — history is never overwritten. |
| 3 | Refresh the index (`CLAUDE.md`). Keep it an index. **3a:** `wrap-prep.js . --evict` mechanically moves the oldest session line out of `CLAUDE.md` into your history file when over the cap. |
| 4 | Write durable always/never rules to `.claude/rules/<topic>.md`. |
| 5 | Fill the session stub (the full narrative lives *here*), then `wrap-prep.js . --flip <id8> --status CONSOLIDATED --label "<Project - Topic - Vol N>" --summary "<short>"` — the index gets a status, not a paragraph. |
| 6 | If it was a real milestone, add one line to `docs/TIMELINE.md`. |
| 7 | Nested projects: feed the parent a one-line digest (`wrap-prep.js . --child-feed "<line>"`). |
| 8 | Refresh the `updated:` date; record cross-project bonds if any. |
| 9 | Re-run integrity; require `broken=0 orphan=0 unindexed=0`. |
| 10 | Print a closing seal as the last thing in chat. |

The seal tells the truth. If steps 1-9 completed **and** integrity is 0/0 it prints `SESSION SEALED · SAVED TO MEMORY`; otherwise `NOT SEALED — WRAP INCOMPLETE` with the blocker. An incomplete wrap is never told it "saved".

**Why step 0 exists.** Before 0.2 the model had to *read* the whole session index and history file just to edit one line (`Edit` needs an exact match). On the workspace where this was measured that was **~41,400 tokens of forced reading** per wrap (estimate: bytes ÷ 3.2) before any thinking began. Flipping a status, moving a line and appending a feed row are mechanical; they no longer use the model.

**`wrap-prep.js` reference**

```
node .claude/scripts/wrap-prep.js <root> [--session <id>]        report only (read-only, default)
node .claude/scripts/wrap-prep.js <root> --gc                    also collect abandoned empty stubs
node .claude/scripts/wrap-prep.js <root> --rotate-backups        also gzip old transcript backups
node .claude/scripts/wrap-prep.js <root> --flip <sid8> --status CONSOLIDATED [--label "…"] [--summary "…"]
node .claude/scripts/wrap-prep.js <root> --evict [--dry-run]     enforce the root-index line cap
node .claude/scripts/wrap-prep.js <root> --child-feed "<line>"   append one row to the parent's feed
node .claude/scripts/wrap-prep.js <root> --json                  machine-readable report
```

Exit codes: `0` clean · `1` integrity FAIL or an action failed · `3` nothing to do (an unchanged `--flip`, an empty `--evict`, no parent for `--child-feed`).

**Check health at any time** with `/ds-recall:status` (read-only): auto-memory state, live locks (and any older than `staleLockHours`), sessions still `🟡 RAW`, integrity numbers, index size against the limit, last milestone.

**If you close without wrapping**, nothing is lost: `SessionEnd` still backs up the transcript and releases the lock, and the next session reports what is owed. Hooks are best-effort — `SessionEnd` is not guaranteed to fire (a crash or hard kill skips it), which is why `SessionStart` runs the same garbage collection.

## 7. Session status model

```
SessionStart ──▶ ⚪ OPEN ──┬─ SessionEnd, stub still empty ───▶ (stub and index line retracted)
 (writes stub +            │
  index line)              └─ SessionEnd, stub has content ──▶ 🟡 RAW ── /ds-recall:wrap ──▶ ✅ CONSOLIDATED
                                                                (the ONLY state that warns)             (terminal)
```

| State | Written by | Warns the next session? |
|---|---|---|
| `⚪ OPEN` | `SessionStart` | never |
| `🟡 RAW` | `SessionEnd` or `wrap-prep --flip`, **only if the stub holds real content** | **yes — the only state that does** |
| `✅ CONSOLIDATED` | `/ds-recall:wrap` (`--flip`) | no; terminal, never downgraded |
| `⚪ CLOSED` | legacy marker from 0.1 | no (honoured for compatibility; GC now removes such stubs) |

"Real content" means more than 20 characters survive after the template scaffolding (frontmatter, title, empty headings, HTML comments) is stripped. The test is deliberately conservative: **a maybe is kept, never collected.**

Why this machine exists: 0.1 wrote a `🟡 RAW` line on every start and counted those lines, so the warning said **59** unconsolidated sessions while **58** of them were empty stubs — a gate wrong 98% of the time teaches you to ignore the 2% that matters. 0.2 fixed the *measurement*, not the volume of the alarm. Details in the [changelog](../CHANGELOG.md).

## 8. The two guards

Both are `PreToolUse` hooks shipped in the plugin's `hooks.json`, so they are active as soon as the plugin is enabled.

### Commit-gate (Moat-1)

- **Fires on:** Bash commands matching `git commit`. Everything else is untouched.
- **Blocks while:** integrity has any **broken**, **orphan** or **unindexed** finding. Size warnings never block.
- **Fail-open:** if the validator itself crashes the commit is allowed (and a message says the guarantee lapsed). A gate must not stop work because of its own bug.
- **Default: on.** Turn it off with `"gateCommit": false`. See [§4](#4-adopting-it-in-a-repo-that-already-has-docs) before enabling on an existing repo.

### Lock-guard (Moat-2)

- **Fires on:** the `Write` and `Edit` tools, when the target's **file name** is in `protected` (default `CLAUDE.md`, `DECISIONS.md`, `SESSIONS_INDEX.md` — matched by basename).
- **Blocks while:** at least one **other** session holds a lock newer than `staleLockHours` (default 12). Your own lock is excluded.
- **Consequence:** with two live sessions in one project, neither can edit the shared canon. That is the design — write to your own session file and consolidate one session at a time.
- **Ghost locks** (left by sessions whose `SessionEnd` never fired) expire after `staleLockHours` and are swept at the next `SessionStart`. To clear one earlier, delete its file in `.claude/active/`.
- **Limit:** it hooks the `Write`/`Edit` tools. It does **not** intercept arbitrary Bash redirects (`echo x >> CLAUDE.md`). Treat it as protection against accidental clobbering, not as a sandbox against a deliberately adversarial agent.

## 9. Several projects: nested workspaces

If a project lives inside a larger workspace — a parent folder with its own `CLAUDE.md` — DS-ReCall treats it as **nested**.

- **Parent detection:** the nearest ancestor directory **above** the project root that contains a `CLAUDE.md` (searched up to 24 levels). Note that *any* `CLAUDE.md` above you counts, including one in a high-level folder you did not think of as a workspace.
- At `SessionStart` the session is told it is a sub-project and that its summary will propagate up.
- At `SessionEnd`, **only if the session produced work**, a placeholder row is appended to the parent's `.claude/CHILD_FEED.md` (if `/ds-recall:wrap` did not already write a meaningful one via `--child-feed`).
- The parent stays lean: **one line, pointer only — never copy detail up.** Detail stays in the sub-project.
- Turn it off with `"nested": false` (no awareness message) and/or `"propagateToParent": false` (no feed rows).

This is how one workspace with twenty sub-projects keeps a single current company index without each project's detail leaking into it.

## 10. The memory graph

`/ds-recall:graph` turns `.claude/SESSIONS_INDEX.md` into a self-contained Canvas 2D page — no CDN, no build step, no model call:

- one **planet per topic**, taken from the `[Project - Topic - Vol N]` tag that `/ds-recall:wrap` writes;
- one **moon per session**, coloured by status;
- a single always-visible **"Needs Wrap"** hot-spot aggregating every `🟡 RAW` session — click it to see exactly what is owed;
- topics worked on the **same calendar day** are joined by an animated bond (derived from the dates already in the index).

By hand: `node <plugin>/scripts/build-memory-graph.js .` writes `_memory-graph/graph-data.js`; copy `assets/memory-graph.html` to `_memory-graph/graph.html` once and open it in a browser. Re-run the builder whenever the index changes. Verified output on a one-session project: `total=1 consolidated=1 raw=0 closed=0 topics=1 bonds=0 dormant=0`.

Optionally group topics under named projects, and surface projects that exist but have no sessions yet (shown dim as *registered, no activity yet*), with the `projects` config key — see the [configuration reference](CONFIGURATION.md#projects).

## 11. Maintenance

Most of it is automatic. The manual tools, all non-destructive by default:

| Task | Command |
|---|---|
| Collect stubs left by crashed sessions | `node .claude/scripts/wrap-prep.js . --gc` (also runs at every `SessionStart` unless `gcEmptyStubs` is `false`) |
| Compress old transcript backups | `node .claude/scripts/wrap-prep.js . --rotate-backups` (also runs at every `SessionEnd`) |
| Enforce the root-index line cap | `node .claude/scripts/wrap-prep.js . --evict --dry-run`, then without `--dry-run` |
| Clear a large backlog left by 0.1 | `node scripts/cleanup.js <project> --dry-run`, then `--apply` |

**Backups.** `SessionEnd` copies the session transcript to `.claude/backups/<id>.jsonl`. **These are full conversation transcripts — keep `.claude/backups/` out of git** (the setup block does). Files older than `backupCompressDays` (default 14) are gzipped with **verify-then-delete**: write the `.gz`, read it back off disk, decompress, compare the byte length, and only then remove the original. **Nothing is ever deleted unless you set `backupDeleteDays` above 0.** At most `backupCompressPerRun` (default 5) files are compressed per hook run so a large backlog cannot stall `SessionEnd`.

**`cleanup.js`** is a one-time tool for the debris 0.1 left behind. Every candidate is copied to `.claude/_arsiv/<date>-temizlik/` with a manifest, read back and byte-compared before the original is removed; anything failing a check is skipped and reported. It never touches `.env*`, `*token*`, `*secret*`, `*credential*`, `.pem`, `.key` or anything matching your own `neverTouch` patterns, and never a session file whose body is non-empty.

**Root-index cap.** Left to human discipline, a root index grows by one line per wrap and nothing removes them (one real index reached 97.8 KB against a 16 KB limit; pruning was planned nine times and deferred nine times). Configure `evict` and `--evict` does it mechanically. See the [configuration reference](CONFIGURATION.md#evict).

## 12. Upgrade and uninstall

**Upgrade.**

```bash
claude plugin update ds-recall      # restart Claude Code to apply
```

Then **re-copy the three project-local scripts** (`validate.js`, `wrap-prep.js`, `session-lib.js`) from the new plugin folder into `.claude/scripts/` of each project. The hooks run the plugin's own copies, but `/ds-recall:wrap` and `/ds-recall:status` run the project-local ones, so they do **not** update by themselves. Compare templates against your own files before overwriting anything you customised.

From 0.1.x to 0.2.x no action is required — hooks are backward compatible and existing `⚪ CLOSED` lines are honoured. The new config keys are optional; copy them from `templates/ds-recall.config.json` if you want them. To clear a 0.1 backlog, use `cleanup.js` ([§11](#11-maintenance)).

**Uninstall.**

```bash
claude plugin uninstall ds-recall
```

This removes the plugin. It does **not** touch what is yours: `CLAUDE.md`, `docs/`, `.claude/rules/`, `.claude/ds-recall.config.json`, `.claude/scripts/`, `.claude/SESSIONS_INDEX.md`, `docs/sessions/` and `.claude/backups/` all stay (delete them if you want them gone). To go back to Claude Code's built-in memory, remove `"autoMemoryEnabled": false` from `.claude/settings.json` (or unset `CLAUDE_CODE_DISABLE_AUTO_MEMORY`).

## 13. What it costs and what it touches

**Tokens.** `claude plugin details ds-recall` (Claude Code's own estimate, v2.1.299): the plugin adds about **158 tokens always-on** per session; invoking a command costs about 2.2k (`wrap`), 0.4k (`status`), 0.6k (`graph`). The three hooks are *harness-only — no model-context cost*. The dominant cost is not the plugin: it is whatever **your own `CLAUDE.md` and `.claude/rules/` weigh**, because Claude Code loads them in full every session. `wrap-prep.js` prints that number (`PER-SESSION FIXED LOAD`) so it stays visible — keep the index lean.

**Model calls and network.** The hooks make **zero model calls**. The runtime scripts import only Node's `fs`, `path` and `zlib` (checked by searching the source; `child_process` appears only in the test harness). Nothing is sent anywhere.

**What gets written into your repo**

| Path | Written by | Notes |
|---|---|---|
| `.claude/active/<id>.lock` | `SessionStart` | live-session lock; removed at `SessionEnd` |
| `docs/sessions/<date>-<id8>.md` | `SessionStart` | session stub; retracted if the session stayed empty |
| `.claude/SESSIONS_INDEX.md` | `SessionStart` / `SessionEnd` / `wrap-prep` | one status line per session; decide for your team whether to commit it (shared history) or ignore it (personal memory) |
| `.claude/backups/<id>.jsonl[.gz]` | `SessionEnd` | **full transcript — never commit** |
| `.claude/.index.lock` | index writes | momentary; removed immediately |
| `.claude/CHILD_FEED.md` (in the *parent*) | `SessionEnd` / `wrap-prep --child-feed` | nested workspaces only |
| `_memory-graph/` | `build-memory-graph.js` | regenerated on demand |

The paths read from config — `sessionsDir`, `sessionsIndex`, `tracked` and the `evict` files — are **contained to the project root**: a copied config containing `"sessionsDir": "../../outside"` falls back to the default instead of turning a hook into an arbitrary-path write.

## 14. Limits

- **No retrieval.** There is no semantic or full-text search over past sessions — recall is `CLAUDE.md`, the index and `grep`. This is the largest gap against automatic tools.
- **Wrap needs a human to ask for it.** It is a command, not a hook. The safety net (transcript backup, lock release, "owed" warning) is automatic; the consolidation is not.
- **The judgement half of `/wrap` is model-driven** and only as good as the session it summarises. Facts that were never verified should be tagged ⚠️ or ❓ — the discipline is yours.
- **The lock-guard does not intercept shell writes** ([§8](#8-the-two-guards)).
- **The commit-gate is on by default** ([§4](#4-adopting-it-in-a-repo-that-already-has-docs)).
- **Project-local scripts are snapshots** ([§12](#12-upgrade-and-uninstall)).
- **Tested mainly on one Windows workspace, Node 22.** Claude Code's marketplace flow was verified end to end on 2.1.299; macOS and Linux reports are welcome.
- **Single maintainer.** Issues and pull requests are read, but expect a small team's pace.
