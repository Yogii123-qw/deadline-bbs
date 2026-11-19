# KIRO-USAGE.md: Honest log of Kiro usage

**Written by the builder (not by Kiro).** Every `kiro-cli` invocation
made during this build, what each one produced, and what the builder
wrote directly. Nothing in this log is reconstructed from memory: the
prompts and raw session logs are kept in the builder's audit directory,
and every file listed below was verified on disk after each call.

## Ground rules that were followed

- Kiro was used only through its native interface, `kiro-cli` 3.4.0,
  run inside this repo directory, in non-interactive mode.
- Every call used the same narrow trust set (recorded per call below):
  `--v3 --no-interactive --trust-workspace
  --trust-tools=fs_read,fs_write,grep,glob,code,introspect`.
  `--trust-all-tools` was never used. The trust set held: Kiro's attempts
  to run shell commands were denied, and it adapted by reading files.
- No file Kiro generated was ever hand-edited. Corrections went through
  new Kiro prompts. **Hand-edits to Kiro artifacts: zero.**
- Credit discipline: the free plan (50 credits/month) shows no balance
  via CLI (`kiro-cli profile` reports the command is Pro-only), so the
  budget was a counted prompt budget: 4 planned + 2 reserve, maximum 6.
  **Used: 5. Reserve remaining: 1, unspent.**
- The builder wrote the prompts; Kiro generated the artifacts.

## Call log

### K1: Steering files (FAILED, transient, partial output kept)

- Prompt: create `.kiro/steering/product.md`, `tech.md`,
  `structure.md`, `conventions.md` for DeadLine BBS, with
  `inclusion: always` front matter as the first content.
- Result: the session ended with a transient
  `ServerConnectionResetError` (exit 1) after ~126s. Partial output was
  kept, unedited: `product.md` complete, `tech.md` incomplete (ends
  after the Ports table), `structure.md` and `conventions.md` missing.
- Files touched by Kiro: `.kiro/steering/product.md`,
  `.kiro/steering/tech.md` (partial).

### K1b: Steering completion (success)

- Prompt: finish `tech.md` by appending the missing sections, then
  create `structure.md` and `conventions.md` to the same standard.
- Result: exit 0 after ~88s. All four steering files verified complete
  with correct front matter. (Kiro's summary misattributed
  `structure.md` to "a prior interrupted session"; a file listing taken
  before K1b showed only two files, so the file was created by K1b.
  Verified on disk, not from Kiro's word.)
- Files touched by Kiro: `.kiro/steering/tech.md` (completed),
  `.kiro/steering/structure.md`, `.kiro/steering/conventions.md`.

### K2: Feature spec (success, spec mode)

- Prompt: generate a Quick Spec for the `deadline-bbs` feature
  (requirements, design, tasks), run with `--mode spec`.
- Result: exit 0 after ~236s.
- Files touched by Kiro: `.kiro/specs/deadline-bbs/requirements.md`
  (283 lines, 103 EARS "THE SYSTEM SHALL" statements, R1–R10),
  `design.md` (748 lines: architecture, 14 types, state machine, IAC and
  WebSocket sequence diagrams, 19 modules, error and testing strategy),
  `tasks.md` (181 lines, 24 tasks, 9 waves, 36 requirement links).
- One design conflict was found by the builder while implementing: the
  state-machine diagram assigned `N` to both "new thread" and "next
  page" in the thread list. The builder resolved it (`>`/`<` for
  pagination, `N` always means new thread) and noted the resolution in
  the engine code and the commit message. The spec file itself was not
  edited.

### K3: Hooks (success)

- Prompt: create `.kiro/hooks/` automation, a Stop hook running
  `npm run verify` and a PostFileSave hook running `npm run check` on
  `src/` and `web/` TypeScript files.
- Result: exit 0 after ~47s.
- Files touched by Kiro: `.kiro/hooks/verify-on-stop.json`,
  `.kiro/hooks/typecheck-on-save.json`. Both are valid JSON, v1 schema,
  correct PascalCase triggers, and reference real npm scripts. They were
  kept exactly as generated (no `description`/`enabled` fields;
  `timeout` inside `action`).
- Honesty note: hook execution was **never observed** during the build.
  The files are valid and reference real scripts, but this log does not
  claim the hooks were seen firing.

### K4: CATACOMB game module (success, with a scope deviation)

- Prompt: implement `src/game/catacomb.ts` to an exact API (constants,
  damage/level-up/monster formulas, purity rules, injectable RNG) plus
  tests in `tests/game/catacomb.test.ts`, importing types ONLY from
  `../shared/types.js` and explicitly NOT creating `types.ts`.
- Result: exit 0 after ~520s. Mechanically verified: `tsc` clean,
  65/65 game tests pass.
- **Scope deviation, disclosed:** Kiro created `src/shared/types.ts`
  (182 lines) unprompted, against the explicit constraint, to resolve
  the import it needed. The file matches the K2 design's type
  definitions exactly. It was kept as Kiro-authored and unedited, and is
  disclosed here rather than silently absorbed.
- Kiro's narration during K4 mentioned a hook catching the missing
  types file, but the session log contains no direct hook-execution
  output, so hook firing remains unverified (see K3 note).
- Files touched by Kiro: `src/game/catacomb.ts`,
  `tests/game/catacomb.test.ts`, `src/shared/types.ts` (unprompted).

### K5/K6: reserve, unspent

No further Kiro calls were needed. All render fixes found during the
headless walkthrough were in builder-owned code (screens, CSS,
transports) and were fixed directly by the builder.

## Addendum, 19 November 2026: LIVE BOARD + FEDERATION layers (builder-written, zero Kiro calls)

After the initial build was verified, the entry was extended with two
new layers, both written directly by the builder:

- **LIVE BOARD**: live broadcast of posts/replies and CATACOMB
  victories to all connected sessions, live presence (join/leave),
  and live caller-to-caller chat across transports, with delivery
  that redraws the prompt and preserves partial input.
- **FEDERATION**: nodes sync message boards over HTTP via an
  append-only log (`sync.json`), with an idempotent, loop-free
  exchange, store-and-forward, a read-only JSON API, and a public
  SSE event stream.

For these layers: **zero `kiro-cli` calls were made** (the tool was not
invoked at all), **no Kiro artifact was touched** (verified: `git diff`
over `.kiro/`, `src/game/catacomb.ts`, `tests/game/catacomb.test.ts`,
and `src/shared/types.ts` shows zero changed lines), and the **1 reserve
prompt remains unspent**. The credit balance is still unknown and still
not claimed. The design, including the append-only log decision and the
competitive research behind the positioning, is recorded in the
builder's post-build amendment
(`plans/kiroween-AMENDMENT-LIVE-BOARD-2026-11-19.md`, outside this
repo). The new layers were verified by the builder: 285/285 tests pass
(212 original + 73 new), real-socket live and two-node federation
integration tests, a two-process demo run, and a headless walkthrough
with 4 inspected screenshots.

## Addendum, 19 November 2026: PRO-DEV round (builder-written, zero Kiro calls)

After the live and federation layers were verified, the entry was
hardened in a PRO-DEV round, written directly by the builder:

- **PBKDF2 passcode hashing** (600,000 iterations, per-account salt),
  with automatic migration of legacy single-round SHA-256 hashes on
  the next successful login.
- **Federated edit/delete**: new `edit` and `tombstone` log entries
  with CRDT-style semantics (last-writer-wins edits, delete-wins,
  idempotent, pending-queue resolution), author-only, archive posts
  immutable.
- **Federated Hall of Fame**: `score` entries through the same log,
  appended only via the existing victory path; local vs network
  sections with per-node attribution.
- **Public read-only archive** (`/archive`): the same data as the JSON
  API, no login, no write path.
- **Node Status screen** (menu item 7): real sync-engine state.
- **Width-aware live frames**: the wrap-fragment display defect fixed.
- **Accessibility pass** on the web shell (skip link, live status,
  labels, focus ring) and a full headless UX audit with 11 inspected
  screenshots.

For this round: **zero `kiro-cli` calls were made** (the tool was not
invoked at all), **no Kiro artifact was touched** (verified: `git diff`
over `.kiro/`, `src/game/catacomb.ts`, `tests/game/catacomb.test.ts`,
and `src/shared/types.ts` shows zero changed lines), and the **1 reserve
prompt remains unspent**. The credit balance is still unknown and still
not claimed. The design, including the log-extension decision taken
before coding and the research synthesis behind it, is recorded in the
builder's post-build amendment
(`plans/kiroween-AMENDMENT-PRO-DEV-2026-11-19.md`, outside this repo).
The round was verified by the builder: 351/351 tests pass (285 prior +
66 new), including real-socket two-node edit/delete and federated-HoF
integration tests and CRDT convergence tests. Exactly one prior test
assertion was changed: the `hashPasscode` format assertion in
`tests/unit/users.test.ts`, which locked the SHA-256 behavior this
round was ordered to replace; all other prior tests pass untouched.

## Honest split

**Generated by Kiro** (never hand-edited):

- All of `.kiro/`, steering (4 files), spec (3 files), hooks (2 files)
- `src/game/catacomb.ts`
- `tests/game/catacomb.test.ts`
- `src/shared/types.ts` (unprompted creation during K4, disclosed above)

**Written directly by the builder:**

- The blueprint, the scaffold, and all other source code and tests
- The web client, the file-area content, and the 1994 archive seeds
- The LIVE BOARD and FEDERATION layers (19 Nov 2026, zero Kiro calls,
  see the addendum above)
- The PRO-DEV round (19 Nov 2026, zero Kiro calls, see the addendum
  above)
- `README.md`, `docs/SUBMISSION.md`, and this log
- All verification: test runs, production builds, headless walkthroughs,
  contrast checks, greps, and the two-node federation demo run

## Credit balance

Not visible via CLI on the free plan. Five prompts were used (K1, K1b,
K2, K3, K4). Whether any credits remain is unknown to the builder and is
not claimed here.
