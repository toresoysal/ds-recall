# Configuration reference

> Applies to **v0.2.1** · every default below was read from the source, not remembered.

DS-ReCall is configured by one optional file per project: **`.claude/ds-recall.config.json`**. No file means all defaults. Start from `templates/ds-recall.config.json`.

**How it is read**

- **Shallow merge.** A key you set **replaces** the default for that key entirely — arrays included. Setting `"ignore": ["vault"]` removes the default `node_modules` and `.git` entries, so list them again if you still want them. The one exception is `evict`, whose fields are merged one level deep (a partial `evict` keeps the other defaults).
- **A malformed file never kills a session.** The hooks fall back to the defaults silently; `validate.js` prints the parse error. If a setting seems ignored, run `node .claude/scripts/validate.js` — a parse error shows up there. (Remember: no trailing commas, no comments in JSON.)
- **Unknown keys are ignored.** The template uses `_v02` and `_why` as inline notes for exactly that reason.
- **Paths are contained.** `sessionsDir`, `sessionsIndex`, `tracked`, `indexes` and the `evict` files must resolve **inside the project root**; a value that escapes (`../../x`) is rejected or falls back to its default.

---

## Integrity checks — read by `validate.js`, the commit-gate, `wrap-prep.js`

| Key | Default | Meaning |
|---|---|---|
| `indexes` | `["CLAUDE.md"]` | Files treated as the **reference source**: every `.md` they link to counts as *referenced*, and a link to a file that does not exist is **BROKEN**. Add sub-indexes here (e.g. `"docs/research/README.md"`); links resolve relative to each index file's own folder. |
| `tracked` | `["docs"]` | Directories scanned for **ORPHAN** notes — a `.md` there that no index references. |
| `ignore` | `["node_modules", ".git"]` | Names skipped when scanning `tracked` and `sessionsDir`. |
| `sizeLimitLines` | `200` | An index file longer than this produces a **SIZE** warning (advisory — never fails). |
| `sizeLimitBytes` | `25600` | Same, in bytes (25 KB, which is also Claude Code's own read limit for `MEMORY.md`). |
| `sessionsIndex` | `.claude/SESSIONS_INDEX.md` | The machine index of sessions. Also read by the hooks (which write it), the graph builder, and the **UNINDEXED** check: a session file with no line here is flagged. If the file does not exist the check is skipped. |
| `sessionsDir` | `docs/sessions` | Where per-session stubs live. Exempt from **ORPHAN** (the index tracks them instead). |

*What counts as a reference:* a markdown link `[x](path.md)`, a path inside `` `backticks` ``, or a bare path that contains a `/`. A bare file-name mention without a slash (prose such as `MEMORY.md`) is deliberately **not** a reference, so it cannot raise a false BROKEN. Anything under `.claude/` is runtime/config and out of integrity scope.

## Guards

| Key | Default | Read by | Meaning |
|---|---|---|---|
| `gateCommit` | **on** (only an explicit `false` turns it off) | commit-gate | Block `git commit` while integrity has any broken, orphan or unindexed finding. **Read [the user guide §4](USER-GUIDE.md#4-adopting-it-in-a-repo-that-already-has-docs) before enabling on an existing repo.** |
| `protected` | `["CLAUDE.md", "DECISIONS.md", "SESSIONS_INDEX.md"]` | lock-guard | File **names** (matched by basename, anywhere in the tree) that `Write`/`Edit` may not touch while another live session holds a lock. Must be an array — anything else falls back to the default rather than silently weakening the guard. |
| `staleLockHours` | `12` | hooks, lock-guard, GC | A lock older than this is a ghost (its session never reached `SessionEnd`): it is ignored by the guard and swept at the next `SessionStart`. It is also the minimum age before an empty stub may be garbage-collected. |

## Capture and garbage collection — read by the session hooks and `wrap-prep.js`

| Key | Default | Meaning |
|---|---|---|
| `gcEmptyStubs` | `true` | At `SessionStart`, collect empty stubs left by sessions that died without `SessionEnd`. Guards, all of which must hold: the file name matches the auto-stub pattern (hand-written notes are never in scope) · the body is empty · no fresh lock for that session · older than `staleLockHours`. |
| `staleDays` | `21` | If `CLAUDE.md` carries `updated: YYYY-MM-DD` (also `LAST UPDATED:` or the Turkish `SON GÜNCELLEME:`) older than this many days, `SessionStart` adds a `STALE INDEX` warning. |
| `nested` | `true` | Tell the session when it is a sub-project of a parent workspace (see the guide, [§9](USER-GUIDE.md#9-several-projects-nested-workspaces)). `false` silences the message. |
| `propagateToParent` | `true` | At `SessionEnd`, append a row to the parent's `.claude/CHILD_FEED.md` when the session produced work. `false` disables the feed. |

## Transcript backups — read by `SessionEnd` and `wrap-prep.js --rotate-backups`

| Key | Default | Meaning |
|---|---|---|
| `backupCompressDays` | `14` | gzip transcript backups older than N days. `0` = never compress. |
| `backupCompressPerRun` | `5` | Compress at most this many files per hook run, so a big backlog cannot stall `SessionEnd`. |
| `backupDeleteDays` | `0` | Hard-delete `.gz` backups older than N days. **`0` = never delete** — the default policy is lossless. |

Compression is **verify-then-delete**: write the `.gz`, read it back off disk, decompress it, compare the byte length with the original, and only then remove the original. Any failure leaves the original untouched.

## Wrap and the index — read by `wrap-prep.js`

| Key | Default | Meaning |
|---|---|---|
| `maxIndexLineChars` | `0` (no limit; the template sets `220`) | `--flip` truncates `[label] · summary` to this many characters, so the machine index stays *status*, not prose. `wrap-prep` also warns about index lines longer than 250 characters. |
| `evict` | see below | Mechanical cap on session lines in the root index. |

### `evict`

The root index grows by one session line per wrap and nothing removes them. `wrap-prep.js . --evict` makes the trim mechanical: the **oldest** session lines are moved (cut and paste, not copy) from your index into a history file.

| Field | Default | Meaning |
|---|---|---|
| `file` | `CLAUDE.md` | File whose session lines are counted. |
| `linePattern` | `^- \[S-` | Regular expression identifying a session line. Lines are assumed **newest first**, so the surplus is at the bottom of the block. |
| `maxLines` | `6` | Keep this many; move the rest. |
| `targetFile` | *none* | History file that receives the moved lines. **Required for `--evict` to act** — without it the command reports and exits `1` without moving anything. |
| `targetAnchor` | `^## ` | Regular expression; moved lines are inserted directly under the first heading that matches. |

```json
"evict": {
  "file": "CLAUDE.md",
  "linePattern": "^- \\[S-",
  "maxLines": 6,
  "targetFile": "docs/sessions/00-INDEX.md",
  "targetAnchor": "^## "
}
```

`targetFile` must already exist. Preview with `node .claude/scripts/wrap-prep.js . --evict --dry-run`.

## Cleanup — read by `cleanup.js`

| Key | Default | Meaning |
|---|---|---|
| `neverTouch` | `[]` | Extra **regular-expression fragments**, matched case-insensitively against file names, that `cleanup.js` must refuse to touch — put your vault and secret folder names here. They are added on top of the built-in floor (`.env*`, `token`, `secret`, `credential`, `.pem`, `.key`). |

## Graph — read by `build-memory-graph.js`

### `projects`

By default `/ds-recall:graph` makes one planet per `[Project - Topic - Vol N]` topic, which works with no setup. If your work spans sub-projects or departments that do not map 1:1 onto topic tags, group them:

```json
"projects": [
  { "id": "Marketing", "match": ["Campaigns", "LinkedIn", "Web Design"] },
  { "id": "Corporate Identity", "match": ["Branding"], "note": "brand work — dormant until a session tags it" }
]
```

`match` lists **topic names**, compared **case-insensitively and exactly** (not as substrings) against the `Topic` part of the tag. A topic no project claims keeps its own planet, so this is additive enrichment, never required. A registered project with **zero** matching sessions still appears, dim, as *registered, no activity yet*.

## Command names

| Key | Default | Meaning |
|---|---|---|
| `wrapCommand` | `/ds-recall:wrap` | The command name printed in `SessionStart` messages, guard messages and the graph. Change it if you expose the commands under another name (for example as project-level slash commands). It only changes the **text shown**, not what runs. |
| `statusCommand` | `/ds-recall:status` | **Reserved.** Present in the defaults but not read by any script in 0.2.1; setting it has no effect today. |

---

## Two starting points

**Adopting it in an existing repo, gently** — nothing blocks a commit until you are ready:

```json
{
  "indexes": ["CLAUDE.md"],
  "tracked": ["docs"],
  "gateCommit": false
}
```

Run `node .claude/scripts/validate.js`, link or move whatever it reports, then remove `gateCommit` (or set it to `true`).

**A workspace with sub-projects** — keep the root index from growing without bound:

```json
{
  "nested": true,
  "propagateToParent": true,
  "maxIndexLineChars": 220,
  "evict": {
    "file": "CLAUDE.md",
    "linePattern": "^- \\[S-",
    "maxLines": 6,
    "targetFile": "docs/sessions/00-INDEX.md",
    "targetAnchor": "^## "
  }
}
```

The full template, with every key, is `templates/ds-recall.config.json`.
