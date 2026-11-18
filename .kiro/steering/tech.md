---
inclusion: always
---

# DeadLine BBS — Tech

## Stack

All versions are pinned in `package.json` and `package-lock.json`.

| Concern | Package / built-in |
|---|---|
| Language | TypeScript 7 strict |
| Runtime | Node.js 24 stdlib (net, http, fs, crypto) |
| WebSocket server | ws 8 |
| Web terminal | @xterm/xterm 6 + @xterm/addon-fit |
| Front-end bundler | Vite 8 |
| Test runner | Vitest 5 |
| Schema validation | Zod 4 |

## Commands

| Command | Action |
|---|---|
| `npm run check` | `tsc` against both server and web tsconfig files |
| `npm test` | Vitest single-run |
| `npm run build` | `tsc` server output then Vite web bundle |
| `npm start` | `node dist/server/main.js` |
| `npm run verify` | `check` then `test` then `build` in sequence |

## Ports and Environment

| Variable | Default | Purpose |
|---|---|---|
| `HTTP_PORT` | `8080` | HTTP server and WebSocket upgrade |
| `TELNET_PORT` | `2323` | Raw TCP telnet listener |

## Data and Persistence

Runtime data lives in `data/` (gitignored JSON files). Every write is atomic: the new content is written to a temp file first, then renamed into place, so a crash never produces a corrupt store. A serialized write queue ensures concurrent sessions never interleave writes to the same file. Persisted JSON is validated with Zod on load; if validation fails, the store falls back to a fresh seeded state and emits a server log warning. File-area content lives in `files/` and is committed to the repo.

## Code Conventions

- ESM only (`"type": "module"` in `package.json`).
- NodeNext module resolution; all relative imports in server code use explicit `.js` extensions.
- Zod validation at every trust boundary: telnet input, WebSocket payloads, file paths, and persisted JSON on load.
- Never use `any` without a written justification in a comment on the same line.
- No `TODO`, `FIXME`, or placeholder code anywhere in the codebase.
- Errors are typed and handled explicitly; never swallowed silently.
