---
description: Show DS-ReCall memory health at a glance — auto-memory state, active sessions, unconsolidated (RAW) sessions, integrity (broken/orphan/size), index size, last milestone. Read-only.
allowed-tools: ["Read", "Grep", "Glob"]
---

# /ds-recall:status — Memory Health Dashboard

Report DS-ReCall state for this project. **Read-only — do not modify any file.** Present a compact dashboard (one line per check), then a one-line verdict: ✅ healthy / ⚠ N issue(s).

## Checks
1. **Auto-memory** — read `.claude/settings.json` and report `autoMemoryEnabled`. Expected `false` (or env `CLAUDE_CODE_DISABLE_AUTO_MEMORY`). If not OFF → ⚠ (uncurated memory drifts alongside the curated layer).
2. **Active sessions** — list `.claude/active/*.lock`. Each is a live session; flag any older than the configured `staleLockHours` (default 12) as a likely ghost lock.
3. **Unconsolidated (RAW)** — count and list `🟡 RAW` lines in `.claude/SESSIONS_INDEX.md`. These still need `/ds-recall:wrap`.
4. **Integrity** — run the validator and report its numbers verbatim:
   ```
   node .claude/scripts/validate.js
   ```
   This command does not pre-approve the Bash tool, so Claude Code asks you to approve this one read-only command. Require 0 broken, 0 orphan. Size warnings are advisory. **If this errors with "Cannot find module"**, the install step that copies `validate.js` into the project was skipped — run `node <plugin>/scripts/init.js` once in the project root (or copy `<plugin>/scripts/validate.js` → `.claude/scripts/validate.js`) and re-run.
5. **Index size** — `CLAUDE.md` line / byte count vs the limit (default 200 lines / 25 KB). Near the limit → suggest moving detail into `docs/`.
6. **Last milestone** — last entry of `docs/TIMELINE.md` (if it exists).

## Output
Six dashboard lines + verdict. This is **observation only** — do not fix anything; for each ⚠, name the command that resolves it (usually `/ds-recall:wrap`).
