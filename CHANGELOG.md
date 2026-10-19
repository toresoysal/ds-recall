# Changelog

All notable changes to DS-ReCall are documented here.

---

## [0.3.0] — 2026-10-19

**The commit-gate stops blocking new users by default, and setting up a project is one command.**

Both changes come from re-testing our own 0.2.1 release on realistic repositories. A fresh install in a repo with a `docs/` folder that `CLAUDE.md` does not link denied **every** `git commit` (measured: `orphan=1`; with a pre-existing `CLAUDE.md` the copied templates became orphans, `orphan=2`). And the one-time setup was eight manual copy commands whose result went stale, silently, at the next plugin upgrade, because `/ds-recall:wrap` and `/ds-recall:status` run the project-local script copies.

### ⚠️ Behaviour change — read this first

- **`gateCommit` now defaults to `"warn"`.** A project whose config has no `gateCommit` key (or no config at all, or a config that is not valid JSON) used to have commits **blocked** while integrity failed; it now gets a **warning** and the commit goes through. **If you rely on blocking, add `"gateCommit": "block"`.** Configs that already say `"gateCommit": true` keep blocking exactly as before; `false` still switches the gate off.

### Added

- **Commit-gate modes** (`scripts/commit-gate.js`). `"warn"` (default): the user sees a warning (`systemMessage`) and Claude receives the same text as context (`hookSpecificOutput.additionalContext`). The hook deliberately returns **no** `permissionDecision`: Claude Code's hook documentation says `"allow"` skips the user's own permission prompt, and a warning must never auto-approve a commit. `true` / `"block"`: deny, as in 0.1 and 0.2. `false` / `"off"`: nothing. Any other value — a typo such as `"blok"` — is treated as `"warn"` **and the warning says the value was not recognised**: a typo must neither silently switch a safety check off nor silently start blocking commits. Values are case-insensitive. A clean workspace is silent in every mode; a non-commit command is never touched.
- **`scripts/init.js`** — one command instead of eight: `node <plugin>/scripts/init.js` run in a project root creates `CLAUDE.md`, `docs/DECISIONS.md`, `docs/TIMELINE.md`, `.claude/ds-recall.config.json`, copies `validate.js` / `wrap-prep.js` / `session-lib.js` into `.claude/scripts/` and adds the runtime lines to `.gitignore`. It **never overwrites a file you have**, is idempotent, and reports what it did (`created` / `kept` / `updated` / `unchanged`). Options: `--dry-run` (writes nothing, with every other flag too), `--upgrade` (re-syncs **only** the three scripts, printing `old -> new`; nothing else is touched), `--append-pointers` (an existing `CLAUDE.md` that does not mention the new decision log / timeline gets the two lines that stop them being orphans — only for files `init.js` created, only once), `--disable-auto-memory` (merges `{"autoMemoryEnabled": false}` into `.claude/settings.json`, original kept as `settings.json.dsr-backup`; **without the flag the state is only reported — settings are never edited silently**). It refuses to run inside the plugin folder or on a clone of the plugin repository, on a folder that does not exist, and on an unknown option; a `.claude/settings.json` it cannot parse is left untouched. `.gitignore` is appended in the file's own line ending and a rule that already ignores `.claude/` counts as covering the `.claude/` lines. No dependencies, no network; paths with spaces work.
- **`scripts/live-check-gate.js`** — proves the commit-gate against a **real, logged-in** Claude Code: it builds two throw-away repos containing one orphan note, loads the plugin with `--plugin-dir`, asks a headless `claude -p` to run `git commit`, and judges from the evidence Claude Code itself emits (`--output-format stream-json --include-hook-events`) plus the real git history: default config → the commit must go through and the hook output must say `NOT blocked`; `"block"` → the commit must be refused and nothing committed. *Status, stated plainly:* the judging logic is covered by tests built from the real gate output; **the live half has not been run by us** — a headless `claude -p` in our environment reported `Not logged in`, which the tool reports as `UNMEASURED` (exit 3), never as a pass. See *Known limitations*.
- **Template**: `templates/ds-recall.config.json` ships `"gateCommit": "warn"` with an explanatory `_gateCommit` note.

### Changed

- **Self-test: 59 → 140 cases.** New groups: 9 *commit-gate modes* (20 cases), 10 *init / upgrade* (52), 11 *live-check judge* (9). Each reports its coverage.
- **The negative harness now injects defects into more than one file** (each injection names its target file) and restores every file on exit — including after a crash or Ctrl-C — instead of only `session-lib.js`.
- **Negative harness result: 35 injections (the 10 from 0.2 + 7 commit-gate + 15 init + 3 live-check) → 34 of 34 exercisable defects make the suite fail · 0 blind · 0 not applied · 1 declared not-exercisable** (the gzip round-trip length check, unchanged from 0.2). Run on both an LF tree and a CRLF copy of the sources.
- Docs: README, `USER-GUIDE.md` (§3 is now the `init.js` flow, §4, §8, §12, §14), `CONFIGURATION.md`, `TROUBLESHOOTING.md` rewritten for 0.3.0. Version `0.2.1` → `0.3.0` (`plugin.json`, `marketplace.json`).

### Found by our own negative harness while building this

The first full run of the new arms reported `RESULT: FAIL` (29 of 31 exercisable defects caught) — and both gaps were in **our** tests, not in the code: a *dry-run* test ran on a project that was already set up, so a defect that made the dry run append to files could not show; and one injection anchor never applied because the source line carries a literal BOM character. Both were fixed (a dry-run case on a project that still needs everything, which also asserts the append path was *seen*; an anchor that does not depend on the BOM) before this release. A test that passes the first time is not evidence — that is what the harness is for.

### Known limitations — documented, not changed

- **The warn output has not been seen by a live Claude Code session by us** (see `live-check-gate.js` above). It follows the documented hook format.
- **The commit-gate only warns by default**: a project that never sets `"gateCommit": "block"` is not protected from commits that fail integrity, and a warning can be ignored.
- **Nothing reminds you to run `init.js --upgrade`** after a plugin upgrade.
- **No retrieval** (no search over past sessions) · **wrap needs a human to ask for it** · **`cleanup.js` is not covered by the self-test suites** (and stamps annotated index lines with a fixed date) · **`SESSIONS_INDEX.md` has no automatic cap** · **`statusCommand`** is a reserved config key that nothing reads.

---

## [0.2.1] — 2026-10-18

**Documentation, one-line install, and a Windows fix. No hook behaviour changed.**

0.2.0 was published without a user guide, with a README whose status section still said
*"v0.1 … not yet published"*, and with no way to install other than cloning the repository.
This release closes that — and a re-run of the verification step the README tells new users to
run turned up one real bug.

### Added

- **One-line install from this repo.** `.claude-plugin/marketplace.json` makes the repository a
  self-hosted marketplace (name `devsoy`):

  ```bash
  claude plugin install ds-recall --marketplace toresoysal/ds-recall --scope project
  ```

  Needs Claude Code 2.1.275+. Before this, the only way in was `git clone` + `--plugin-dir`.
  `claude plugin validate` passes; the install was exercised end to end from a local checkout
  (marketplace add → install → `plugin list` → `plugin details`) in an isolated Claude config
  directory, for both user and project scope.
- **`docs/USER-GUIDE.md`** — install, per-project setup (copy-paste for macOS/Linux and Windows),
  the daily loop, the status machine, both guards, nested workspaces, maintenance, upgrade,
  uninstall, cost and privacy, limits. The lifecycle it describes was run on a scratch project
  (SessionStart → SessionEnd → catch-up warning → `--flip` → validator, including a deliberate
  broken-link / orphan negative).
- **`docs/CONFIGURATION.md`** — every key in `.claude/ds-recall.config.json` with its default and
  which script reads it, read from the source. It also records that `statusCommand` is defined
  in the defaults but **not read by any script**.
- **`docs/TROUBLESHOOTING.md`** — symptom → cause → fix.
- **`.gitattributes`** — keeps the tree LF on every platform.

### Fixed

- **`selftest-negative.js` reported `RESULT: FAIL` on Windows checkouts.** Git for Windows
  defaults to `core.autocrlf=true`, which checks files out with CRLF line endings. One of the
  harness's injection anchors spans two lines, so on CRLF it silently stopped matching
  (`anchor not found`) and the *"verify the install"* step of the README failed on a healthy
  install. The anchors now adapt to the file's own line ending; restoring the source stays
  byte-exact. Verified on the same source: **CRLF copy → `CAUGHT 9 · NOT-APPLIED 0 · OK`**,
  LF copy → same, and the 0.2.0 harness on that CRLF copy → `CAUGHT 8 · NOT-APPLIED 1 · FAIL`
  (the control that shows the test can see the bug).
- **User-facing text in English.** `validate.js` printed its diagnostics in Turkish
  (`! index bulunamadi`, `… satir`, `… config kacagi`, `config parse hatasi`); the header comments
  of `validate.js`, `commit-gate.js` and `lock-guard.js` were Turkish; `templates/CLAUDE.md` still
  carried `status: aktif`, `referans | etki | bağımlı` and `SON OTURUMLAR`, while `/wrap` documents
  the English link types `reference | affects | depends-on | supersedes`. Comments and messages
  only — the results of `validate.js` on a real workspace are identical before and after.
- **`validate.js` default `ignore`** no longer lists a folder name specific to the workspace the
  tool was built in (it had no effect: only `tracked` folders are scanned).
- **README** — the status section no longer says "v0.1 … not yet published"; the section titled
  "Four building blocks" listed five; the competitor table no longer claims silent truncation of
  the built-in memory (see *Changed*).

### Changed

- **README rewritten** around install paths, the one-time project setup, an honest comparison and
  an explicit *Limits* section. The built-in auto-memory row was corrected: since Claude Code
  **2.1.210** a write that leaves `MEMORY.md` over its read limit returns an explicit error
  instead of truncating silently, and since 2.1.268 the truncation warning says how many lines
  were cut. The remaining difference to DS-ReCall is **curation, not visibility**.
- **Version** `0.2.0` → `0.2.1` (`plugin.json`, `marketplace.json`).

### Known limitations — documented, not changed

- **The commit-gate is on by default.** On an existing repo with a `docs/` folder that no index
  links to, `git commit` is blocked until the notes are linked or `"gateCommit": false` is set.
  Measured on a fresh install. Whether the default should be gentler is an open decision; for now
  it is called out in the README, the guide and the troubleshooting page.
- **No retrieval.** There is no search over past sessions — the index plus `grep`.
- **Project-local copies of `validate.js`, `wrap-prep.js` and `session-lib.js` do not update
  themselves** when the plugin is upgraded; `/wrap` and `/status` run those copies. Re-copy them.
- **`cleanup.js` is not covered by the self-test suites.** Read the `--dry-run` output before
  `--apply`. It also stamps annotated index lines with a fixed date (`2026-08-07`) instead of the
  run date — cosmetic.
- **`SESSIONS_INDEX.md` has no automatic cap** (`evict` trims only the root index).
- **`statusCommand`** is a reserved config key that nothing reads.

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
