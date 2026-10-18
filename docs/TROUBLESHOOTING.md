# Troubleshooting

> Applies to **v0.2.1** · symptom → cause → fix. Where an entry says "measured", it was reproduced on a real run.

**Quick map** —
[Commit blocked](#my-git-commit-is-blocked) ·
[Cannot find module](#cannot-find-module-claudescripts) ·
[Edit denied: shared canon](#an-edit-to-claudemd-is-denied-other-sessions-hold-a-lock) ·
[Auto-memory warning](#the-auto-memory-may-be-on-warning-will-not-go-away) ·
[Unconsolidated work](#unconsolidated-work-n-earlier-sessions) ·
[Nothing happens at session start](#nothing-happens-at-session-start) ·
[Command not found](#ds-recallwrap-is-not-found) ·
[NOT SEALED](#wrap-ends-with-not-sealed) ·
[Backups](#the-backups-folder-is-huge) ·
[Index growth](#sessions_indexmd-keeps-growing) ·
[Windows self-test](#windows-selftest-negativejs-reports-fail--anchor-not-found) ·
[Graph](#the-graph-is-empty-or-wont-animate) ·
[Config ignored](#my-config-seems-to-be-ignored)

---

### My `git commit` is blocked

```
[DS-ReCall] Commit blocked — memory integrity FAIL: 0 broken, 1 orphan, 0 unindexed session(s). …
```

**Cause.** The commit-gate is **on by default** and found a problem. Measured: on a fresh install in a repo that has `docs/foo.md` and no `CLAUDE.md` linking to it, every `git commit` is denied with exactly this message.

**Find out why:**

```bash
node .claude/scripts/validate.js
```

| Finding | Meaning | Fix |
|---|---|---|
| `BROKEN  CLAUDE.md -> docs/x.md` | an index links to a file that does not exist | fix the link or create the file |
| `ORPHAN  docs/x.md` | a note under a `tracked` folder that no index references | link it from `CLAUDE.md`, or from a sub-index you list in `indexes`; or move it out of `tracked`; or add its folder to `ignore` |
| `UNINDEXED  docs/sessions/x.md` | a file in `sessionsDir` whose **file name appears nowhere** in `SESSIONS_INDEX.md` (typically a hand-written note) | add a line to `.claude/SESSIONS_INDEX.md` that contains the file name, e.g. `- S-<id8> · 2026-10-18 18:40 · ✅ CONSOLIDATED · docs/sessions/x.md`. Measured: `wrap-prep.js --flip` for such a session inserts a line **without the path**, so it does *not* clear this finding. |

**Bypass.** Set `"gateCommit": false` in `.claude/ds-recall.config.json`. Size warnings never block. If the validator itself crashes the commit is allowed and a message says so (fail-open by design).

### Cannot find module `.claude/scripts/…`

`/ds-recall:wrap` and `/ds-recall:status` run the **project-local** copies of `validate.js`, `wrap-prep.js` and `session-lib.js`. The one-time setup step that copies them was skipped (or you upgraded the plugin and a project has none). Copy **all three** — `wrap-prep.js` requires `session-lib.js` from the same folder — see the [user guide §3](USER-GUIDE.md#3-set-up-a-project-once).

### An edit to `CLAUDE.md` is denied: other sessions hold a lock

```
"CLAUDE.md" is shared canon and 1 other active session(s) hold a lock (…). Writing now risks clobbering. …
```

**Cause.** The lock-guard blocks `Write`/`Edit` to protected files while **another** session holds a lock newer than `staleLockHours` (default 12). That is the design.

**Fixes, in order:**

1. **Normal case:** another session really is live. Write to your own session file and consolidate one session at a time.
2. **Ghost lock:** a session that crashed or was hard-killed never reached `SessionEnd`, and its lock still counts as live **for up to `staleLockHours`**. If you know it is dead, delete its file in `.claude/active/` (`<session-id>.lock`).
3. **Change the policy:** edit `protected` (file names matched by basename) or lower `staleLockHours`.

The guard hooks `Write` and `Edit` only; a shell redirect is not intercepted.

### The "AUTO-MEMORY may be ON" warning will not go away

`SessionStart` looks in exactly two places: the environment variable **`CLAUDE_CODE_DISABLE_AUTO_MEMORY`** and **this project's `.claude/settings.json`** for `"autoMemoryEnabled": false`. It does **not** read your *user* settings, nor `settings.local.json`.

That matters because Claude Code's own `/memory` toggle saves `autoMemoryEnabled` to your **user** settings (`~/.claude/settings.json`) — so switching it off there silences Claude Code's auto-memory but **not** this warning. Add it to the project file:

```json
{ "autoMemoryEnabled": false }
```

### `UNCONSOLIDATED WORK: N earlier session(s)…`

```
UNCONSOLIDATED WORK: 1 earlier session(s) have content but no /ds-recall:wrap (abcd1234). …
```

**Meaning.** These sessions' files hold real content (more than 20 characters beyond the template scaffolding) and were never marked `✅ CONSOLIDATED`. Empty stubs are *not* counted — that is the point of 0.2.

**Fix.** Open the project and run `/ds-recall:wrap` for them, one session at a time. If a session genuinely needs no consolidation, you can mark it by hand — only after you have decided that:

```bash
node .claude/scripts/wrap-prep.js . --flip <id8> --status CONSOLIDATED --summary "no consolidation needed"
```

(`⚪ CLOSED` is a legacy marker and does **not** silence the warning for a session that has content.)

**Coming from 0.1 with dozens of stale entries?** Preview a one-time cleanup first: `node scripts/cleanup.js <project> --dry-run`. It archives and byte-compares before removing anything, and `cleanup.js` is **not** covered by the self-test suites, so do read the dry-run output.

### Nothing happens at session start

No `[DS-ReCall]` context line means the hooks did not run. Check, in order:

1. **Is the plugin enabled here?** `claude plugin list` should show `ds-recall@devsoy` with `Status: ✔ enabled`. A **project-scope** install only enables it in the project whose `.claude/settings.json` declares it.
2. **Did you restart Claude Code** after installing or updating? (`claude plugin update` says a restart is required.)
3. **Is Node on the `PATH` of the process that launches Claude Code?** The hooks are plain `node …` commands. `node --version` in a terminal is not proof for a desktop app started from a launcher; start Claude Code from a terminal to compare.
4. **Loaded with `--plugin-dir`?** The path must point at the folder that contains `.claude-plugin/plugin.json`.

### `/ds-recall:wrap` is not found

Plugin commands are **namespaced**: `/ds-recall:wrap`, `/ds-recall:status`, `/ds-recall:graph`. If they do not appear when you type `/`, the plugin is not enabled in this session (previous entry). The `wrapCommand` config key changes only the *text* DS-ReCall prints, not what runs.

### `/wrap` ends with `NOT SEALED`

By design the seal tells the truth: it prints `NOT SEALED — WRAP INCOMPLETE` when a step was left incomplete (for example a write was blocked by the lock-guard) **or** integrity is not `0 broken / 0 orphan`. The box names the blocker. Fix it, then run `/ds-recall:wrap` again, or check integrity directly with `node .claude/scripts/validate.js`.

### The backups folder is huge

`.claude/backups/` holds **full session transcripts**, one per session. Nothing deletes them by default. After `backupCompressDays` (14) they are gzipped with verify-then-delete (original removed only after the `.gz` is read back and matches in length); `backupDeleteDays` defaults to `0`, so **nothing is ever deleted** unless you ask. To compress a backlog now: `node .claude/scripts/wrap-prep.js . --rotate-backups` (at most `backupCompressPerRun` files per run). To also delete old ones, set `backupDeleteDays`. **Keep the folder out of git** — it contains everything you and Claude said.

### `SESSIONS_INDEX.md` keeps growing

It gets one line per session **that did work**; abandoned empty sessions are removed. There is **no automatic cap** on this file (`evict` only trims the *root* index, e.g. `CLAUDE.md`). `maxIndexLineChars` keeps each line short; if the file bothers you, archive old `✅ CONSOLIDATED` lines by hand — the graph builder and the UNINDEXED check read it, so keep the recent ones.

### Windows: `selftest-negative.js` reports `FAIL` — "anchor not found"

```
? path containment removed
    anchor not found — injection could not be applied (source drifted?)
RESULT: FAIL
```

**Cause (0.2.0 only).** Git for Windows defaults to `core.autocrlf=true`, which checks files out with CRLF line endings; one multi-line anchor in the harness stopped matching, so a healthy install reported `FAIL`. Measured on the same source: a CRLF checkout gave `CAUGHT 8 … NOT-APPLIED 1 … RESULT: FAIL`; the LF checkout gave `CAUGHT 9 … NOT-APPLIED 0 … RESULT: OK`.

**Fix.** Upgrade to **0.2.1** — the harness now adapts to the file's line ending and the repo ships a `.gitattributes` that keeps the tree LF.

### The graph is empty or won't animate

- It is built from `.claude/SESSIONS_INDEX.md`. With no session lines there is nothing to draw, and DS-ReCall will not invent placeholder sessions.
- `/ds-recall:graph` rebuilds the data first (`node <plugin>/scripts/build-memory-graph.js .`). If you opened an old `_memory-graph/graph.html` directly, re-run the builder.
- Open `_memory-graph/graph.html` in a **normal browser** for the full experience. Embedded preview panels can time out while screenshotting the animation loop — a tooling quirk, not a sign anything is broken.

### My config seems to be ignored

1. **Is the JSON valid?** A malformed file silently falls back to defaults in the hooks; `node .claude/scripts/validate.js` prints the parse error.
2. **Shallow merge.** A key you set replaces the default entirely, arrays included — `"ignore": ["vault"]` drops `node_modules` and `.git`.
3. **Contained paths.** A path that escapes the project root is rejected or falls back to its default.
4. **A reserved key.** `statusCommand` is present in the defaults but not read by any script in 0.2.1.

Every key and its default: [configuration reference](CONFIGURATION.md).

---

## Still stuck?

Open an issue at <https://github.com/toresoysal/ds-recall/issues> with: your OS, `node --version`, the Claude Code version, the output of `claude plugin list`, and the output of `node .claude/scripts/validate.js`. Redact paths you would rather not share — the reports print the project path.
