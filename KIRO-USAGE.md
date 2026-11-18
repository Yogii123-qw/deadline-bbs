# KIRO-USAGE.md — Honest log of Kiro usage

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

### K1 — Steering files (FAILED, transient, partial output kept)

- Prompt: create `.kiro/steering/product.md`, `tech.md`,
  `structure.md`, `conventions.md` for DeadLine BBS, with
  `inclusion: always` front matter as the first content.
- Result: the session ended with a transient
  `ServerConnectionResetError` (exit 1) after ~126s. Partial output was
  kept, unedited: `product.md` complete, `tech.md` incomplete (ends
  after the Ports table), `structure.md` and `conventions.md` missing.
- Files touched by Kiro: `.kiro/steering/product.md`,
  `.kiro/steering/tech.md` (partial).

### K1b — Steering completion (success)

- Prompt: finish `tech.md` by appending the missing sections, then
  create `structure.md` and `conventions.md` to the same standard.
- Result: exit 0 after ~88s. All four steering files verified complete
  with correct front matter. (Kiro's summary misattributed
  `structure.md` to "a prior interrupted session"; a file listing taken
  before K1b showed only two files, so the file was created by K1b.
  Verified on disk, not from Kiro's word.)
- Files touched by Kiro: `.kiro/steering/tech.md` (completed),
  `.kiro/steering/structure.md`, `.kiro/steering/conventions.md`.

### K2 — Feature spec (success, spec mode)

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

### K3 — Hooks (success)

- Prompt: create `.kiro/hooks/` automation — a Stop hook running
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

### K4 — CATACOMB game module (success, with a scope deviation)

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

### K5/K6 — reserve, unspent

No further Kiro calls were needed. All render fixes found during the
headless walkthrough were in builder-owned code (screens, CSS,
transports) and were fixed directly by the builder.

## Honest split

**Generated by Kiro** (never hand-edited):

- All of `.kiro/` — steering (4 files), spec (3 files), hooks (2 files)
- `src/game/catacomb.ts`
- `tests/game/catacomb.test.ts`
- `src/shared/types.ts` (unprompted creation during K4, disclosed above)

**Written directly by the builder:**

- The blueprint, the scaffold, and all other source code and tests
- The web client, the file-area content, and the 1994 archive seeds
- `README.md`, `docs/SUBMISSION.md`, and this log
- All verification: test runs, production builds, headless walkthroughs,
  contrast checks, and greps

## Credit balance

Not visible via CLI on the free plan. Five prompts were used (K1, K1b,
K2, K3, K4). Whether any credits remain is unknown to the builder and is
not claimed here.
