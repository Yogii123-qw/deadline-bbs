# DeadLine BBS — Implementation Tasks

Tasks are grouped into waves. Within a wave, tasks are independent of each other and can be worked in parallel. A task in wave N must not begin until all tasks in waves 1 through N-1 are complete.

Requirement group abbreviations: R1 = Telnet transport, R2 = WebSocket/web terminal, R3 = Auth, R4 = Boards, R5 = Atomic persistence, R6 = CATACOMB, R7 = File area, R8 = Who's online / time tracking, R9 = ANSI art / errors, R10 = No mocks.

---

## Wave 1 — Foundation (no dependencies on other source modules)

### Task 1.1 — Project scaffold (R9, R10)
Set up `package.json` with all pinned dependencies (TypeScript 7, Node 24, ws 8, @xterm/xterm 6, @xterm/addon-fit, Vite 8, Vitest 5, Zod 4). Configure `tsconfig.json` (strict, NodeNext), `tsconfig.build.json` (server output to `dist/server/`), `tsconfig.web.json` (web bundle), and `vite.config.ts`. Add `.gitignore` covering `dist/`, `data/`, `node_modules/`. Create the directory structure described in `structure.md`. Add `npm run check`, `npm test`, `npm run build`, `npm start`, and `npm run verify` scripts.
**Satisfies**: overall project runability; prerequisite for all other tasks.

### Task 1.2 — Shared types (R3, R4, R5, R6, R7, R8)
Create `src/shared/types.ts` with all TypeScript interfaces: `UserRecord`, `Board`, `Post`, `Thread`, `GameCharacter`, `Monster`, `CombatResult`, `HallOfFameEntry`, `FileEntry`, `SessionState`, `SessionPhase`, `ActiveSession`, `EngineDeps`, `PendingRegistration`, `BoardContext`, `GameContext`, `FileContext`, `ReadMarkers`. Export every type. No runtime logic.
**Satisfies**: R3, R4, R5, R6, R7, R8 (data shape definitions).

### Task 1.3 — Zod validation schemas (R3, R4, R5, R6, R7, R2)
Create `src/shared/validation.ts` with Zod schemas for every persisted type (`zUserRecord`, `zUsersStore`, `zBoardsStore`, `zScoresStore`) and every trust-boundary input (`zWebSocketPayload`, `zTelnetInput`, `zFilePathParam`). Each schema must be strict (no `.passthrough()`). Export schemas and their inferred TypeScript types.
**Satisfies**: R3, R4, R5, R6, R2.

### Task 1.4 — Typed error classes (R3, R4, R5, R6, R7, R9)
Create `src/shared/errors.ts` with `BbsError` as base class and subclasses: `AuthError`, `ValidationError`, `StoreError`, `FileAreaError`, `GameError`. Each class sets `this.name` to its class name for structured logging. Export all classes.
**Satisfies**: R3, R4, R5, R6, R7, R9.

---

## Wave 2 — Infrastructure utilities (depends on Wave 1)

### Task 2.1 — ANSI escape helpers (R9, R1)
Create `src/telnet/ansi.ts` with pure helper functions: `esc`, `moveCursor`, `clearScreen`, `clearLine`, `color`, `bold`, `reset`, `stripAnsi`, `hideCursor`, `showCursor`, `reverseVideo`. `stripAnsi` must remove all ANSI/VT100 escape sequences including CSI, OSC, and private-mode sequences. Export all functions.
**Satisfies**: R9, R1 (prerequisite for screen rendering and ANSI injection stripping).

### Task 2.2 — Atomic JSON store (R5)
Create `src/boards/store.ts` implementing `AtomicStore<T>`. Constructor takes `filePath`, a Zod schema, and a seed value. `read()` deserializes and validates; on failure logs warning and returns seed. `write(updater)` serializes a promise chain (one per instance) so writes are strictly sequential; each write goes to `<file>.tmp` then `fs.rename` to target. Import `node:fs/promises`, `node:path`, `node:os`. Export `AtomicStore`.
**Satisfies**: R5.

### Task 2.3 — Telnet IAC negotiation parser (R1)
Create `src/telnet/negotiation.ts` implementing `TelnetNegotiator`. Maintains a byte buffer for split-packet tolerance. Parses WILL/WONT/DO/DONT and sub-negotiation (SB/SE) sequences. Emits events: `'data'` (printable bytes), `'negotiation'` (option event), `'naws'` (width, height). On construction, generates and returns the initial IAC bundle (WILL ECHO, WILL SGA, DO SGA, DO NAWS). Responds to incoming WILL/DO with the server's option table per the design. Never crashes on malformed input; discards unrecognized sequences.
**Satisfies**: R1.

---

## Wave 3 — Stores and business logic (depends on Wave 2)

### Task 3.1 — User store (R3, R5)
Create `src/users/users.ts`. Instantiate `AtomicStore` backed by `data/users.json` with `zUsersStore` schema and empty-users seed. Implement `findUser`, `createUser` (salt + SHA-256 hash, never log plaintext), `authenticate` (throws `AuthError` on failure), `updateUser`, `updateReadMarker`. Validate handle length (2–20) and strip ANSI sequences before persisting. Validate passcode length (min 4) on registration.
**Satisfies**: R3, R5.

### Task 3.2 — Board store and operations (R4, R5, R10)
Create `src/boards/store.ts` (or extend the generic store) for `data/boards.json` with `zBoardsStore` schema. Create `src/boards/boards.ts` with `listBoards`, `listThreads` (sorted newest-first), `getThread`, `createThread`, `replyToThread`, `getUnreadCounts`. Strip ANSI from subject and body before persisting. Enforce subject max 72 chars and body max 4,096 chars; throw `ValidationError` on excess. Add seed data: four named boards plus at least one archive post per board, each with `isArchive: true` and author field containing "ARCHIVE - 1994", dated 1994.
**Satisfies**: R4, R5, R10.

### Task 3.3 — Full-text search (R4)
Create `src/boards/search.ts` with `search(query, store)`. Case-insensitive substring match against `post.subject` and `post.body` across all boards. Return up to 50 `SearchResult` objects each containing `boardId`, `threadId`, `postId`, `subject`, `authorHandle`, `excerpt` (first 150 chars of matching field). Empty query returns empty results without error.
**Satisfies**: R4.

### Task 3.4 — CATACOMB game logic (R6)
Create `src/game/catacomb.ts` with pure functions: `startSession`, `takeTurn`, `runCombatRound`, `generateMonster`, `applyLevelUp`, `checkWinCondition`, `resetCharacter`. Inject `rng: () => number` parameter for all random decisions. Define at least six distinct monster types at increasing difficulty, culminating in the Crypt Lord (final boss, `isFinalBoss: true`). `startSession` checks `turnsResetDate` against today and resets `turnsUsedToday` if the date has changed. No file I/O anywhere in this module.
**Satisfies**: R6.

### Task 3.5 — Hall of Fame scores store (R6, R5)
Create `src/game/scores.ts`. Instantiate `AtomicStore` backed by `data/scores.json`. Implement `recordVictory(handle, level)` (appends a `HallOfFameEntry`, persists) and `getHallOfFame()` (returns entries sorted by level descending, timestamp ascending).
**Satisfies**: R6, R5.

### Task 3.6 — File area (R7)
Create `src/files/filearea.ts`. Implement `resolveFilePath` with the path-traversal guard (resolve, check prefix, lstat + realpath for symlinks). Implement `listFiles` (reads `files/` directory, returns `FileEntry[]` with name, size, description from a sidecar `.info` file or empty string). Implement `readFileInline` (returns full text of a `.txt` file; throws `FileAreaError` for non-text files). Implement `isTextFile` (checks extension against an allowlist: `.txt`, `.nfo`, `.ans`, `.diz`).
**Satisfies**: R7.

---

## Wave 4 — Session engine (depends on Wave 3)

### Task 4.1 — ANSI screens (R9, R4, R6, R7, R8)
Create `src/session/screens.ts` with all screen-builder functions listed in the design: `splashScreen`, `mainMenu`, `boardListScreen`, `threadListScreen`, `threadViewScreen`, `composeScreen`, `fileListScreen`, `filePager`, `combatScreen`, `hallOfFameScreen`, `whoOnlineScreen`, `errorScreen`. Use ANSI art for the splash screen and all section headers. Use `ansi.ts` helpers throughout. All functions are pure and return strings.
**Satisfies**: R9, R4, R6, R7, R8.

### Task 4.2 — Input line reader (R1, R2, R3)
Create `src/session/input.ts` with `processKeystroke(state, byte)`. Handle: backspace (DEL / `\x7f` and `\x08`), CR/LF normalization (emit line on `\r`, `\n`, or `\r\n`), control-character filtering. During passcode phases (`PASSCODE_PROMPT`, `CONFIRM_PASSCODE`), return empty string for `echo` so the transport does not echo characters. Map single-character game commands (`A`ttack, `R`un, `Q`uit, directional keys) to `PlayerAction` values when in `CATACOMB` or `CATACOMB_COMBAT` phases.
**Satisfies**: R1 (echo control), R2, R3 (passcode masking).

### Task 4.3 — Session state machine engine (R3, R4, R6, R7, R8, R9, R10)
Create `src/session/engine.ts` with `processInput(ctx: EngineInput): Promise<EngineOutput>`. Implement a handler per `SessionPhase` as described in the design's state-transition table. Each handler receives the current state plus `EngineDeps` and returns `{ state: SessionState, output: string }`. The engine never imports transport modules. Record `connectedAt` timestamp on session creation. Expose elapsed-time calculation. Update `ActiveSessions` via `deps` on successful auth and on logoff. Dispatch to `screens.ts` for all rendered output. Catch all typed errors from stores and display them via `screens.errorScreen`.
**Satisfies**: R3, R4, R6, R7, R8, R9, R10.

---

## Wave 5 — Transport servers (depends on Wave 4)

### Task 5.1 — Telnet TCP server (R1, R8)
Create `src/server/telnet.ts`. Create a `net.Server`. On connection: instantiate `TelnetNegotiator`, create initial `SessionState` (phase `SPLASH`), write the IAC bundle and splash screen. Wire `data` event: bytes → negotiator → `input.processKeystroke` → completed lines → `engine.processInput` → write output. Handle `naws` negotiation event to update `state.terminalWidth`/`Height`. On `close` and `error`: log the event, remove session from `ActiveSessions`. Export a `startTelnetServer(port, deps)` function.
**Satisfies**: R1, R8.

### Task 5.2 — HTTP server and file download (R2, R7)
Create `src/server/http.ts`. Create a `node:http` server. Serve static files from the Vite build output (`dist/web/`) with correct `Content-Type` headers. Handle `GET /files/:name` by calling `filearea.resolveFilePath` then streaming the file with `Content-Disposition: attachment` and inferred MIME type. Return 404 for unknown paths. Emit WebSocket upgrade events to ws-bridge. Export `startHttpServer(port, deps)`.
**Satisfies**: R2, R7.

### Task 5.3 — WebSocket bridge (R2, R8)
Create `src/server/ws-bridge.ts`. Attach a `ws.Server` to the HTTP server's upgrade event. On each new WebSocket: create a `SessionState` (phase `SPLASH`), send the splash screen as a text frame. On `message` event: parse frame with `zWebSocketPayload`; if it is a resize event update terminal dimensions; otherwise route text through `engine.processInput` and send output back as a text frame. On `close`/`error`: clean up session, remove from `ActiveSessions`. Export `attachWsBridge(httpServer, deps)`.
**Satisfies**: R2, R8.

### Task 5.4 — Server bootstrap (R1, R2, R8)
Create `src/server/main.ts`. Read `HTTP_PORT` (default 8080) and `TELNET_PORT` (default 2323) from `process.env`. Instantiate stores (users, boards, scores). Instantiate `ActiveSessions` map. Call `startTelnetServer` and `startHttpServer` / `attachWsBridge`. Register `process.on('unhandledRejection')` to log and not crash. Log startup ports on success.
**Satisfies**: R1, R2, R8.

---

## Wave 6 — Web terminal client (depends on Wave 5 scaffold, independent of engine)

### Task 6.1 — xterm.js web client (R2)
Create `web/index.html` with a full-page terminal container. Create `web/main.ts`: instantiate `xterm.Terminal` and `FitAddon`, open the terminal in the container, attach the FitAddon, connect a `WebSocket` to `ws://<host>/` (or `wss://` on HTTPS). On WS `message`: write data to the xterm terminal. On xterm `onData`: send keystrokes as a text WS frame. On window `resize`: re-fit and send a JSON resize frame `{ type: "resize", cols, rows }`. Create `web/styles.css` with minimal styles to make the terminal fill the viewport with a black background.
**Satisfies**: R2.

---

## Wave 7 — Unit tests (depends on Wave 3 and Wave 4)

### Task 7.1 — Unit tests: shared utilities (R5, R9)
Create `tests/unit/ansi.test.ts`: test `stripAnsi` against ANSI color codes, CSI sequences, OSC sequences, and mixed content. Create `tests/unit/store.test.ts`: test atomic write pattern, concurrent-write serialization, Zod validation failure falls back to seed, missing file initializes from seed.
**Satisfies**: R5, R9.

### Task 7.2 — Unit tests: users (R3, R5)
Create `tests/unit/users.test.ts`: test `createUser` stores hash not plaintext, `authenticate` succeeds with correct passcode, `authenticate` throws `AuthError` with wrong passcode, duplicate handle rejected, handle too short rejected, handle too long rejected, passcode too short rejected, `updateReadMarker` persists correctly.
**Satisfies**: R3, R5.

### Task 7.3 — Unit tests: boards and search (R4, R5)
Create `tests/unit/boards.test.ts`: test thread creation, reply, unread count calculation, subject too long throws, body too long throws, ANSI stripped from subject and body, threads sorted newest-first, archive seed posts have `isArchive: true`. Create `tests/unit/search.test.ts`: test case-insensitive match in subject, match in body, no match returns empty, empty query returns empty.
**Satisfies**: R4, R5.

### Task 7.4 — Unit tests: CATACOMB game logic (R6)
Create `tests/game/catacomb.test.ts`: test `runCombatRound` with deterministic RNG returns expected damage values, monster defeat awards XP, player defeat returns `playerDefeated: true`, `checkWinCondition` returns true for Crypt Lord, `resetCharacter` restores starting stats, turn decrement persists, turn reset fires when date changes, `applyLevelUp` increases stats correctly.
**Satisfies**: R6.

### Task 7.5 — Unit tests: file area (R7)
Create `tests/unit/filearea.test.ts`: test `resolveFilePath` accepts valid filename, rejects `../` traversal, rejects absolute path that escapes base, `readFileInline` returns text content for `.txt`, throws `FileAreaError` for missing file, `isTextFile` returns true for allowed extensions and false for others.
**Satisfies**: R7.

### Task 7.6 — Unit tests: telnet negotiation (R1)
Create `tests/unit/negotiation.test.ts`: test single-chunk IAC WILL ECHO parsed correctly, DO NAWS triggers naws event with correct dimensions, split-packet IAC sequence buffers and completes on second chunk, unrecognized WILL receives DONT response, mixed printable + IAC yields correct printable data and negotiation events.
**Satisfies**: R1.

---

## Wave 8 — Integration and walkthrough tests (depends on Wave 5 and Wave 6)

### Task 8.1 — Integration tests: telnet (R1, R3, R4, R7, R8)
Create `tests/integration/telnet.test.ts`. Start the telnet server on an ephemeral port using real sockets. Write helper to connect a `net.Socket`, complete IAC negotiation, and exchange line-based input/output. Test: full register flow, full login flow, login failure returns to handle prompt, navigate to boards and read a thread, navigate to file area and list files, path-traversal attempt returns error, abrupt disconnect cleans up session.
**Satisfies**: R1, R3, R4, R7, R8.

### Task 8.2 — Integration tests: WebSocket (R2, R3, R8)
Create `tests/integration/websocket.test.ts`. Start the HTTP + WS server on an ephemeral port. Use the `ws` client library. Test: WS connect receives ANSI splash, login via WS, navigate to boards, resize frame updates terminal dimensions in session state, WS close removes session from ActiveSessions.
**Satisfies**: R2, R3, R8.

### Task 8.3 — Integration tests: concurrent writes (R5)
Create `tests/integration/concurrent-writes.test.ts`. Simulate two concurrent sessions posting to the same board simultaneously (using `Promise.all`). After both complete, verify both posts are present in the store and the JSON is well-formed.
**Satisfies**: R5.

### Task 8.4 — Headless walkthrough test (R10)
Create `tests/integration/walkthrough.test.ts`. Script a complete session via telnet socket: connect → register → main menu → boards → read archive post → new post → reply → search → file list → inline read → CATACOMB entry (verify turn display) → logoff. Verify every step produces non-empty ANSI output and no step returns an error screen. This test asserts end-to-end feature completeness.
**Satisfies**: R10 (and exercises R1, R3, R4, R6, R7, R9).

---

## Wave 9 — Documentation (depends on all prior waves passing `npm run verify`)

### Task 9.1 — README (R10)
Create `README.md` with: prerequisites (Node 24, npm), install (`npm install`), run (`npm start`), connect instructions for both telnet (`telnet localhost 2323`) and browser (`http://localhost:8080`), environment variable table, feature summary, and judge verification checklist that walks through every requirement group R1–R10.
**Satisfies**: R10.

### Task 9.2 — Submission docs (R10)
Create `docs/SUBMISSION.md` with: project name and category (Resurrection), one-paragraph description, feature list keyed to R1–R10, judge quick-start steps, any known limitations or deliberate cuts (with reasons), and attribution of any third-party assets.
**Satisfies**: R10.

### Task 9.3 — KIRO-USAGE log (R10)
Create `KIRO-USAGE.md`. Log each module with two columns: what Kiro generated and what the human builder wrote or modified. Update this file as work progresses. The log must be accurate; never claim Kiro did work it did not do.
**Satisfies**: R10 (conventions/honesty requirement).

### Task 9.4 — Seed file content (R10)
Populate the `files/` directory with at least three text files suitable for the file area: a BBS welcome text, a rules/etiquette document, and one additional file (e.g. an ASCII art piece or a local scene description). Add `.info` sidecar files (`<filename>.info`) with one-line descriptions for each. Commit all files to the repo.
**Satisfies**: R7, R10.
