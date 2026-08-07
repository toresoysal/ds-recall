---
description: Consolidate the current session into curated memory — extract decisions, update the index, mark the session consolidated, and verify integrity. Run before ending a session.
disable-model-invocation: true
allowed-tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]
---

# /ds-recall:wrap — Session Consolidation

You are closing a work session. Melt the raw session into the curated, status-tagged canon so the next session starts with **zero drift**. This is the *smart* half of DS-ReCall; the deterministic half (backup + lock release) runs automatically on SessionEnd.

Work through the steps below. Do not invent facts — every claim must be verifiable.

---

## 🔴 STEP 0 — RUN THIS FIRST (one command, ~50 ms)

```bash
node .claude/scripts/wrap-prep.js . --gc
```

You get a ~40-line briefing: this session's stub and status · sessions that genuinely still
need consolidating · the root-index line cap · per-session fixed load · integrity.

### ⛔ Do NOT open these files — the script already read them

| file | why not |
|---|---|
| `.claude/SESSIONS_INDEX.md` | use `--flip` (step 5) |
| your history file (e.g. `docs/sessions/00-INDEX.md`) | use `--evict` (step 3a) |
| `.claude/CHILD_FEED.md` | use `--child-feed` (step 7) |

> **Why this step exists.** Before v0.2 the model had to READ each of these in full just to edit
> one line, because `Edit` needs an exact match. On the workspace where this was measured that
> was **~41,400 tokens of forced reading** per wrap — up to ~72,900 once the root-index cap was
> enforced — before a single word was written. That was the slow, expensive wrap. Flipping a
> status, moving the oldest line and appending a feed row are mechanical; they do not need a
> language model. Your tokens belong to the part that needs judgement.

Grepping one line out of those files is fine. Reading them whole is not.

---

## 1. Read the session
Review what actually happened: decisions made, problems solved, facts discovered, files changed, open threads.

## 2. Extract PERMANENT decisions → decision log
For each durable decision (one that should outlive this session), append a dated, reasoned entry to the decision log (`docs/DECISIONS.md` or the project's equivalent). If a decision reverses an earlier one, mark the old entry outdated (⛔) and **ADD** the new one — never overwrite history.

## 3. Update the index (CLAUDE.md)
Refresh the lean index to reflect the new current state: decisions list, open questions, "last updated". Keep it an INDEX — point to detail files, never copy detail in. **One fact lives in one file** (a copy is drift).

### 3a. Enforce the root-index line cap — mechanically, not by hand

```bash
node .claude/scripts/wrap-prep.js . --evict
```

Moves the oldest session line out of `CLAUDE.md` and into your history file (cut-and-paste, not
a copy). Step 0 already told you whether anything is over the cap.

> **Why this is a command and not an instruction.** When this was left to human discipline, the
> root index reached **97.8 KB against a 16 KB limit**. Pruning was planned nine times and
> deferred nine times, and the file grew on every one of those nine occasions. A rule that
> depends on somebody remembering to delete is not a rule. Configure it under `evict` in
> `.claude/ds-recall.config.json`.

## 4. Extract PERMANENT rules → .claude/rules/
If the session produced a durable "always / never" rule, write it to `.claude/rules/<topic>.md` (native, auto-loaded every session). Don't leave rules buried in conversation.

## 5. Fill the session stub + mark it consolidated
`SessionStart` opened an empty stub at `docs/sessions/<date>-<id>.md` (it did NOT fill it). Fill it now: work done, decisions (also logged in step 2), open threads. **The full narrative lives here** — the index gets a status, not a paragraph.

Then flip the status **without opening the index**:

```bash
node .claude/scripts/wrap-prep.js . --flip <id8> --status CONSOLIDATED --label "<Project - Topic - Vol N>" --summary "<short>"
```

`--summary` is truncated at `maxIndexLineChars` (default 220). That cap is the only structural
guarantee the machine index does not grow prose again — on the reference workspace the same
summary was living in **three** places at once (index 51.2 KB + history file 78.0 KB + the
session file itself), and every wrap had to update all three.

**Title tag (Project - Topic - Vol N):** prefix the index summary (right after the status marker, before the free-text summary) with `[<Project> - <Topic> - Vol <N>]`:
- `<Project>` = the top-level workspace/project folder name, Title Case (e.g. `Acme`).
- `<Topic>` = a 1-2 word Title Case slug for this session's main subject (e.g. `Recall`, `Billing`, `Onboarding`). Pick ONE dominant thread even if the session touched several — this is a filing label, not a summary.
- `<N>` = count existing `SESSIONS_INDEX.md` lines whose tag matches `[<Project> - <Topic> - Vol` (same Project+Topic pair, case-insensitive) + 1. A new Project+Topic pair starts at `Vol 1`.
- If the session genuinely mixed unrelated topics, tag with the dominant one — the user can hand-edit the sidebar/session name afterward regardless (ds-recall has no API to rename the app's own session title, only this index tag).

## 6. Update TIMELINE + stamp close
If this session reached a **milestone** (a real turning point, not routine work), append a dated line to `docs/TIMELINE.md`: `- <YYYY-MM-DD HH:mm> · <what changed> · → <session stub>`. Use the system time injected at session start — do not guess it. Also ensure the stub's `closed:` stamp is set (SessionEnd writes it best-effort; add it if missing).

## 7. Up-propagate to the parent (nested workspaces)
If this project lives inside a larger workspace (a parent folder with its own `CLAUDE.md`), feed the parent a ONE-LINE dated digest so the company index stays current without bloat:

```bash
node .claude/scripts/wrap-prep.js . --child-feed "<this-project> · <YYYY-MM-DD HH:mm> · S-<id> · <≤8-word what-changed>"
```

- If it was a **milestone**, also add a one-line entry under the parent `CLAUDE.md` recent-sessions section. **Never copy detail up — one line, pointer only.**

## 8. Refresh staleness + bonds
- Set the index header `updated: <today>` and `status:` so the next session can tell current-vs-old at a glance (time-blindness shield).
- If this session created or changed a **cross-project dependency**, record it in the parent's bonds registry (e.g. `docs/BONDS.md`): typed (`reference | affects | depends-on | supersedes`), directional, dated. If a referenced file moved/was deleted, mark the bond ⛔ stale.

## 9. Integrity check (gate)
Re-run step 0 and require `RESULT: OK` with `broken=0 orphan=0 unindexed=0`. Or call the validator directly:

```
node .claude/scripts/validate.js
```

Require **0 broken, 0 orphan** before treating the session as closed.
**Re-running is the point:** "the script ran" is not a verification — seeing the number change is. **If this errors with "Cannot find module"**, the install step that copies `validate.js` into the project was skipped — copy it from the plugin root (`<plugin>/ds-recall/scripts/validate.js` → `.claude/scripts/validate.js`) and re-run before treating the wrap as sealed.

## 10. Closing seal (the LAST thing you print to chat — required)
End every wrap with a closing seal that makes it obvious, at a glance, that the session is **finished and saved to memory**. This is the **last thing you print** — add nothing after it. Goal: when an old session is reopened, "consolidated + saved" is instantly clear.

**The seal tells the truth (not decoration):**
- If steps 1-9 completed cleanly **AND** integrity is **0 broken / 0 orphan** → print the **SEALED** block.
- If any step was left incomplete (e.g. a write was blocked, another session held a lock) **OR** integrity is not 0/0 → print the **NOT SEALED** block. Never tell an incomplete wrap that it "saved".

Print the block **inside a code block** (so the left rule lines up). Date = the system time injected at session start (do not guess it). `<id8>` = first 8 chars of the session id. `<what changed>` = ≤10 words from the step-5 summary.

**SEALED (success) — print verbatim, fill placeholders:**

```
╔═══════════════════════════════════════════════════════
║  🎬  T O   B E   C O N T I N U E D …
║
║  📼  SESSION SEALED · SAVED TO MEMORY
║  S-<id8>   ·   <YYYY-MM-DD HH:mm>
║  ✅ integrity  ·  0 broken / 0 orphan
║  ▸ <what changed — ≤10 words>
║  ▸ next session resumes with ZERO drift
╚═══════════════════════════════════════════════════════
```

**NOT SEALED (incomplete/failed) — print verbatim:**

```
╔═══════════════════════════════════════════════════════
║  ⏸️  NOT SEALED — WRAP INCOMPLETE
║
║  ⛔  memory was NOT saved cleanly
║  S-<id8>   ·   <YYYY-MM-DD HH:mm>
║  ✗ integrity  ·  <N> broken / <M> orphan   (must be 0/0)
║  ▸ blocker: <what was blocked / missing>
║  ▸ fix it → run /ds-recall:wrap again
╚═══════════════════════════════════════════════════════
```

## Status discipline (source monitoring)
Tag every fact: ✅ verified · ⚠️ assumption · ⛔ outdated · ❓ unknown.
Never write an unverified number, date, or mechanism — if you can't verify it, write "unknown / test it".
