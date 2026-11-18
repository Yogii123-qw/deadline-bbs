---
inclusion: always
---

# DeadLine BBS — Project Structure

## Folder Layout

| Path | Contents |
|---|---|
| `src/server/` | `main.ts` (bootstrap), `telnet.ts` (TCP listener), `http.ts` (HTTP server), `ws-bridge.ts` (WebSocket-to-session adapter) |
| `src/session/` | `engine.ts` (session state machine), `screens.ts` (ANSI screen builders), `input.ts` (line reader / input routing) |
| `src/telnet/` | `negotiation.ts` (IAC option parser/negotiator), `ansi.ts` (ANSI escape helpers) |
| `src/boards/` | `store.ts` (atomic JSON persistence), `boards.ts` (board and thread logic), `search.ts` (full-text search) |
| `src/game/` | `catacomb.ts` (turn-based dungeon game), `scores.ts` (Hall of Fame persistence) |
| `src/files/` | `filearea.ts` (directory listing, inline paging, download, path-traversal guard) |
| `src/users/` | `users.ts` (registration, authentication, passcode hashing, user records) |
| `src/shared/` | `types.ts` (shared TypeScript types), `validation.ts` (Zod schemas), `errors.ts` (typed error classes) |
| `web/` | `index.html`, `main.ts` (xterm.js client), `styles.css` |
| `tests/unit/` | Unit tests for business-logic modules |
| `tests/integration/` | Integration tests against real sockets |
| `tests/game/` | Unit and scenario tests for CATACOMB |
| `files/` | File-area content committed to the repo |
| `data/` | Runtime JSON stores (gitignored) |
| `docs/SUBMISSION.md` | Hackathon submission notes |
| `KIRO-USAGE.md` | Log of what Kiro generated vs. what the human builder wrote |
| `README.md` | Setup and usage guide |

## Layering Rule

- **Transports** (`src/telnet/`, `src/server/telnet.ts`, `src/server/http.ts`, `src/server/ws-bridge.ts`) only move bytes in and out. They contain no session or business logic.
- **Session engine** (`src/session/engine.ts`) is a pure state machine. It accepts input strings and returns output strings with no direct socket access, so it is fully testable without sockets.
- **Stores** (`src/boards/store.ts`, `src/users/users.ts`, `src/game/scores.ts`) own all persistence. No other module writes to `data/` directly.
- **Game logic** (`src/game/catacomb.ts`) is pure functions over explicit state; it does not read from or write to disk itself — the caller passes state in and receives new state back.
