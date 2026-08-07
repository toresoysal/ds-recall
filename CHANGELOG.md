# Changelog

All notable changes to DS-ReCall are documented here.

---

## [0.2.0] — 2026-08-07

**The catch-up warning was measuring the wrong thing, and the wrap was paying for it.**

This release started as a bug report from the workspace DS-ReCall was built for: *"every session
tells me 50-60-70 sessions are still RAW, but I close them all by hand and the number keeps
going up. And `/wrap` has got slow — 15-20 minutes and a lot of tokens."*

Both complaints turned out to have the same root cause.

### The bug

`SessionStart` wrote a session stub **and** a `🟡 RAW` index line unconditionally, on every
session. Nothing ever removed them. The catch-up warning then counted those index lines — so it
was answering *"has a line been written?"*, not *"is there work to consolidate?"*

Measured on the reference workspace:

| | |
|---|---|
| what the warning said | **59** unconsolidated sessions |
| stubs with a completely empty body | **58** |
| sessions that actually held work | **1** |
| stub churn | **10-19/day**, 75% empty (255 of 338) |

Closing sessions carefully did nothing, because the litter was created at **start**, not at end.

**The damage was not only noise.** Noise hid signal: the new detector surfaced a 7 KB session
record — a live customer-facing search-timeout fix — that an earlier manual cleanup had
mislabelled as *"empty stub"*. A gate that is wrong 98% of the time teaches its reader to skip
the 2% that matters.

### Added

- **A real status machine.** `⚪ OPEN` (session started — never warns) → `🟡 RAW` (the session
  file has content and wrap is owed — the **only** thing that warns) → `✅ CONSOLIDATED`
  (terminal). *"A session existed"* and *"a session produced work"* are now different facts.
- **`scripts/session-lib.js`** — shared core: emptiness detection, serialised index writes,
  garbage collection, backup rotation, path containment.
- **`scripts/wrap-prep.js`** — the deterministic half of `/wrap`:
  `--flip` (change a status without reading the index) · `--evict` (enforce the root-index line
  cap mechanically) · `--child-feed` · `--gc` · integrity. Prints a ~40-line briefing.
- **`scripts/selftest.js`** — 59 cases across 8 groups. Every group reports its **coverage
  count**, because *"0 violations"* carries no information unless you also say how many cases
  were examined.
- **`scripts/selftest-negative.js`** — injects real defects into the source and proves the suite
  goes **red**, then restores byte-for-byte. A green suite proves nothing on its own.
- **`scripts/cleanup.js`** — one-time backlog cleanup: archive → byte-compare → only then remove.
- New config keys: `gcEmptyStubs`, `backupCompressDays`, `backupCompressPerRun`,
  `backupDeleteDays`, `maxIndexLineChars`, `neverTouch`, `evict`.

### Fixed

- **False catch-up alarm** — the warning now counts sessions whose file holds real work.
  Cross-checks the index against the actual file body, because the index alone can lie.
- **Litter is collected.** `SessionEnd` retracts its own record when the session produced
  nothing. `SessionStart` runs the same GC, because `SessionEnd` never fired for **88 of 338**
  stubs (26% — crashes and hard kills). Cleanup cannot rely on the close path alone.
- **One stub per session id**, not one per calendar day. Resuming a session the next day used to
  spawn a second empty stub; **58 session ids** were affected, the worst having **5** files.
- **Duplicate index lines** — check-then-append is not atomic; two concurrent `SessionStart`s
  both read *"absent"* and both appended. Index writes are now serialised behind a short-lived
  advisory lock that never blocks a session for more than ~1s and always falls through to a
  best-effort write rather than losing the record.
- **Status is resolved across all lines for an id**, not the first match. Legacy day-suffixed
  twins (`- S-abc12345-0806 · ⚪ CLOSED`) were masking the canonical `✅ CONSOLIDATED` line and
  resurrecting **4 finished sessions** as pending work.
- **Backups no longer grow without bound.** They had reached **1,038.9 MB** across 76 files
  (largest single file 76.9 MB) with no rotation and nothing reading them.
  Rotation is **verify-then-delete**: gzip → write → read back off disk → decompress → compare
  byte length → *only then* unlink the original. `backupDeleteDays` defaults to **0**, so the
  default policy is **lossless**: files are compressed, never deleted.
- **`validate.js`** — the paths-with-spaces fix from 2026-08-02 is now in the public release.
  A path like `my project/notes.md` used to produce a phantom BROKEN entry pointing at a
  non-existent `project/notes.md`, so the gate failed while the file sat right there on disk.

### Changed

- **`/wrap` no longer reads the big index files.** Flipping one status line used to require
  reading ~41,400 tokens of index (and up to ~72,900 once the root-index line cap was enforced)
  before a single word was written, because `Edit` needs exact matches. That was the slow,
  expensive wrap. The model now reads a short briefing and spends its tokens on meaning.
- **`maxIndexLineChars`** caps index line length. The machine index holds *status*; the prose
  belongs in the session file. On the reference workspace the same summary was living in three
  places at once (index 51.2 KB + history file 78.0 KB + the session file) — duplication is
  exactly the drift this project exists to prevent.
- `CHILD_FEED` receives a row only when the session produced work.

### Known limitation, stated rather than hidden

`selftest-negative.js` reports **9 of 9 exercisable** defects caught. One guard — the gzip
round-trip length check — cannot be isolated by a single-defect injection, because zlib either
throws on a corrupt buffer (already covered by another arm) or returns the exact original. It is
reported as **NOT-EXERCISED** with its reason declared *before* the run, rather than counted as
verified. It is kept as defence-in-depth for a future streaming refactor, where partial output
becomes reachable.

The negative harness found **two blind arms** on its first run — one of them a data-loss guard
that was never actually exercised. That is the point of it: a negative test proves a gate can
*break*; it does not prove what the gate *covers*. Both questions have to be asked.

### Upgrading from 0.1.x

No action required — hooks are backward compatible and existing `⚪ CLOSED` lines are honoured.

Optional, recommended:

```jsonc
// .claude/ds-recall.config.json
{
  "gcEmptyStubs": true,
  "backupCompressDays": 14,
  "backupDeleteDays": 0,          // 0 = never delete, only compress
  "maxIndexLineChars": 220,
  "neverTouch": ["vault", "secrets"],   // extra filename patterns cleanup must refuse
  "evict": {
    "file": "CLAUDE.md",
    "linePattern": "^- \\[S-",
    "maxLines": 6,
    "targetFile": "docs/sessions/00-INDEX.md",
    "targetAnchor": "^## "
  }
}
```

To clear an existing backlog (dry-run first — it prints exactly what it would do):

```bash
node scripts/cleanup.js /path/to/project --dry-run
node scripts/cleanup.js /path/to/project --apply
```

Everything it removes is archived to `.claude/_arsiv/<date>-temizlik/` with a manifest, and
each file is byte-compared against its copy before the original is touched.

---

## [0.1.0] — 2026-07-01

Initial public release: SessionStart/SessionEnd hooks, `validate.js` integrity gate,
`lock-guard` concurrency lock, `commit-gate`, `/wrap` · `/status` · `/graph` commands,
project templates.
