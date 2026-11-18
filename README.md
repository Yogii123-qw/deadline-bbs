# DeadLine BBS — The bulletin board system that refuses to die

**Kiroween 2026 · Category: Resurrection**

The first public dial-up BBS, CBBS, went online on 16 February 1978. By
1994 roughly 60,000 BBSes served 17 million users in the US. Then cheap
dial-up internet and the Mosaic browser crashed the market in late 1994,
and by 1995 bulletin board technology was suddenly obsolete. DeadLine
brings it back — not as a museum skin, but as a real, working, multi-node
BBS you can actually call.

One session engine serves two transports:

- **Real Telnet** — RFC 854 negotiation (ECHO, Suppress-Go-Ahead, NAWS),
  genuine ANSI screens. Any standard telnet client can connect.
- **Web terminal** — xterm.js over WebSocket, in a CRT shell that works
  on desktop and phones.

## Quick start

```sh
npm install
npm start
```

Then open <http://localhost:8080> or run `telnet localhost 2323`.
No accounts to create elsewhere, no API keys, no paid services. A new
handle registers on the spot the first time you call.

Ports and paths are configurable: `HTTP_PORT` (default 8080),
`TELNET_PORT` (default 2323), `DATA_DIR` (default `./data`),
`FILES_DIR` (default `./files`).

## What you can do on the board

- **Handles** — register and log in with a passcode. Passcodes are stored
  as salted SHA-256 hashes, never in plain text. Passcode entry echoes
  `*` on both transports.
- **Message boards** — four boards, threads and replies, per-user read
  markers with unread counts, full-text search across all boards. Posts
  are persisted atomically (temp file + rename, serialized write queue),
  so concurrent callers cannot corrupt each other's posts.
- **CATACOMB** — a door game: a turn-based dungeon crawl with 20 turns a
  day, a persistent character, leveling, five depths, and a Hall of Fame.
  Defeat the Crypt Lord on depth 5 to win.
- **File area** — browse and read text files inline; from the web client
  you can also download them over HTTP. (From telnet, the board tells you
  the web address for downloads — a raw telnet session has no download
  channel, and we do not pretend otherwise.)
- **Who's online** — real concurrent sessions, across both transports,
  with per-call time tracking.

## Honest disclosures

- **The 1994 archive.** The boards ship with eight seeded threads dated
  1994, written as era-authentic starter content. Every one is labeled
  `[ARCHIVE]` in the board and carries `isArchive: true` in the data.
  They are lore, not fake users: nothing pretends to be active, and every
  post you write is real persisted data under your own handle.
- **The `N` key.** In a thread list, `N` always means "new thread".
  Pagination uses `>` and `<`. The screen footer says so on every page.
- **What is not here.** No XMODEM, no FidoNet, no SSH transport. Those
  are real protocols that deserve real implementations, not stubs.

## Architecture

```
src/
  server/     HTTP + static + downloads, telnet server, WebSocket bridge
  session/    the one engine: state machine, screens, line reader
  telnet/     RFC 854 negotiator, ANSI helpers
  boards/     message store, search, 1994 archive seeds
  game/       CATACOMB rules (pure, injectable RNG) + Hall of Fame scores
  users/      handles, passcode hashes, read markers
  shared/     types, Zod validation, error classes
web/          xterm.js CRT client (Vite)
files/        the file area's downloadable text files
tests/        212 tests: unit, game, and real-socket integration
```

The session engine is transport-agnostic: `processInput({state, input,
deps})` is the same function whether the bytes arrived over TCP or a
WebSocket. The telnet negotiator is a stateful RFC 854 parser that
tolerates split packets and only answers state changes, so negotiation
can never loop.

## Development

```sh
npm run verify   # typecheck + tests + production build
npm test         # vitest
npm run check    # tsc, all three configs
npm run build    # server to dist/, web client to dist/public/
```

## How Kiro was used

Kiro (via `kiro-cli`, its native interface) generated the entire
`.kiro/` folder — steering, the feature spec, and the hooks — plus the
CATACOMB game module, its 65 tests, and the shared types file. The rest
of the code, the tests, and this README were written directly by the
builder. The full, honest log — every Kiro call, what each one produced,
and what the builder wrote — is in [`KIRO-USAGE.md`](KIRO-USAGE.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
