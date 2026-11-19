# DeadLine BBS: The bulletin board system that refuses to die

**Kiroween 2026 · Category: Resurrection**

The first public dial-up BBS, CBBS, went online on 16 February 1978. By
1994 roughly 60,000 BBSes served 17 million users in the US. Then cheap
dial-up internet and the Mosaic browser crashed the market in late 1994,
and by 1995 bulletin board technology was suddenly obsolete. DeadLine
brings it back, not as a museum skin, but as a real, working BBS you
can actually call:

**A community board anyone can run, reachable from anything, and owned
by no one.**

- **Anyone can run it:** `npm install && npm start`. No accounts to
  create elsewhere, no API keys, no paid services, no configuration
  files. A new handle registers on the spot the first time you call.
- **Reachable from anything:** real Telnet (RFC 854, any standard
  client) and a web terminal that works on desktop and phones, the
  same board, the same callers, at the same time.
- **Owned by no one:** self-hosted, and nodes federate: several DeadLine
  nodes sync their boards over HTTP, so a community survives any single
  node going down. There is no central server and no company in the
  middle.

## Three layers

**1. Revival.** A faithful BBS: handles with passcodes, four message
boards with threads, replies, per-user read markers and unread counts,
full-text search, a file area, and CATACOMB, a door game with 20 turns a
day, a persistent character, five depths, and a Hall of Fame. The boards
ship with eight 1994 archive threads, each labeled `[ARCHIVE]`, starter
lore, honestly marked, never pretending to be active users.

**2. Live.** A 1994 BBS was one phone line = one caller; two callers
never shared a moment. DeadLine does what that hardware could not:

- **Live broadcast:** when a caller posts a thread or reply, every
  other connected session, telnet and web, sees it inline,
  immediately. When someone slays the Crypt Lord, the whole board
  hears about it. Edits and deletions broadcast the same way, marked
  as edits/deletions.
- **Live presence:** callers see each other arrive and hang up, and
  who's online reflects the real, current sessions.
- **Live chat:** `6 <handle> <message>` sends a private message to a
  caller who is online right now, across transports (telnet ↔ web).
  Bare `6` shows who is online and the syntax.
- **Delivery that respects your typing:** a live notice clears every
  line your partial input occupies. The frame is width-aware, so a
  wrapped input leaves no fragments, prints the notice, then
  redraws your prompt plus whatever you had already typed. Your
  input buffer is never touched, verified by frame-level tests and
  by a narrow-width headless screenshot of a notice landing
  mid-typing.

**3. Federation.** FidoNet, reborn on the modern internet, without the
1990s machinery of mailers, tossers, and nodelists:

- Each node keeps an **append-only log** (`sync.json`) of five entry
  kinds: `thread`, `reply`, `edit`, `tombstone`, and `score`. Every
  entry has a globally unique id (`<node-id>:<uuid>`). Entries are
  operations with CRDT-style semantics: adds are idempotent,
  edits are last-writer-wins, tombstones win over late adds and
  edits (delete-wins), and scores form a grow-only set, so any two
  replicas that have received the same entries converge to the same
  boards, regardless of delivery order. Proven by convergence tests
  that deliver entries in shuffled and duplicated order. An edit or
  tombstone that arrives before the post it refers to waits in a
  pending queue and applies automatically when the post arrives.
- Nodes exchange logs over **`POST /sync/exchange`**. One round trip
  converges both ways. Exchange is **idempotent** (receiving an entry
  twice never duplicates a post) and **loop-free** (discrete rounds
  over immutable entries; an entry circling a 3-node ring arrives back
  as a no-op). Proven by real two-node and three-node integration
  tests.
- **Store-and-forward:** if a peer is offline, entries stay in the log
  and the next successful round delivers them. A restarted node pulls
  everything it missed on startup.
- A **read-only JSON API** (`/api/boards`, `/api/boards/:id/threads`,
  `/api/threads/:id`, `/api/status`) exposes the same data the terminal
  shows, and a public **SSE stream** (`/api/events`) carries live
  post/victory/presence/edit events. Chat messages never enter the
  public stream.
- When a federated post arrives, local callers see it live, marked
  with its origin node: `(via node …)`.
- **Federated Hall of Fame:** a Crypt Lord victory appends a `score`
  entry to the same log, so victories travel with the boards. The Hall
  of Fame shows THIS NODE and THE NETWORK sections, each score
  attributed to its origin node. Scores enter the log only through
  the victory path. There is no other way to record one.
- **Node Status** (menu item `7`) shows the live federation state of
  the node you called: node id, peers, log entries, pending queue,
  last sync round, and whether the sync secret is set. Real numbers
  from the sync engine, not static text.

## Quick start

```sh
npm install
npm start
```

Then open <http://localhost:8080> or run `telnet localhost 2323`.

Ports and paths are configurable: `HTTP_PORT` (default 8080),
`TELNET_PORT` (default 2323), `DATA_DIR` (default `./data`),
`FILES_DIR` (default `./files`).

### Federation setup

```sh
# Node A
HTTP_PORT=8081 TELNET_PORT=2324 DATA_DIR=data/node-a \
  DEADLINE_NODE_ID=node-a DEADLINE_PEERS=http://127.0.0.1:8082 \
  npm start

# Node B (in another terminal)
HTTP_PORT=8082 TELNET_PORT=2325 DATA_DIR=data/node-b \
  DEADLINE_NODE_ID=node-b DEADLINE_PEERS=http://127.0.0.1:8081 \
  npm start
```

Or run the scripted demo (builds once, then starts both nodes):

```sh
./demo-federation.sh
```

Federation settings (all optional; without them a node runs standalone,
exactly as before):

- `DEADLINE_NODE_ID`: override the node identity (otherwise a UUID is
  generated and persisted in `sync.json`). Do not change it for an
  existing data directory.
- `DEADLINE_PEERS`: comma-separated base URLs of peer nodes. Must be
  valid `http(s)` URLs; anything else fails startup with a clear error.
- `SYNC_SECRET`: shared secret for the sync endpoint (see below).
- `SYNC_INTERVAL_MS`: periodic sync interval, default 60000. `0`
  disables the timer (startup sync and push-on-post still run).

**Trust model: read this before peering.** The sync endpoint accepts a
shared secret via `SYNC_SECRET`, compared in constant time
(`X-Sync-Secret` header). **If `SYNC_SECRET` is not set, the sync
endpoint is OPEN: anyone who can reach it can push entries** (entries
are still validated and sanitized, but their origin is unverified).
Without a secret, use DeadLine federation only on trusted or demo
networks. A shared secret is a bearer secret, not per-node identity; no
stronger security claim is made. The server prints a warning at startup
when no secret is set.

**Federation limits (honest):** no synchronized moderation (an
operator's local deletion does not propagate, choose your peers); no
compatibility with FidoNet/FTN or ActivityPub (this protocol is
DeadLine's own HTTP/JSON log exchange, and cannot exchange messages
with existing FidoNet or fediverse networks); full-log exchange per
round, suited to community scale, not millions of posts; edit conflicts
resolve by the origin node's wall clock (last-writer-wins), so skewed
clocks can order two near-simultaneous edits unexpectedly. The result
is still deterministic and identical on every node; federated scores
trust the peer set exactly as posts do. A malicious peer holding the
shared secret could forge scores, so scores are display-only reputation
with nothing at stake; the 1994 archive seeds never federate (each
node's archive is local lore); accounts, read markers, game characters,
presence, and chat stay per-node (the same handle on two nodes is two
different people, and a post's origin node is shown, not a verified
cross-node identity). Edit/delete sync, formerly listed here, was
closed on 19 November 2026 (see above).

## What you can do on the board

- **Handles**: register and log in with a passcode. Passcodes are
  stored as PBKDF2-HMAC-SHA256 hashes (600,000 iterations, the OWASP
  minimum; 128-bit per-account salt), never in plain text. Passcode
  entry echoes `*` on both transports. Accounts created under the
  original single-round SHA-256 scheme migrate to PBKDF2
  automatically on their next successful login. No account is ever
  locked out by the upgrade.
- **Message boards**: four boards, threads and replies, per-user read
  markers with unread counts, full-text search across all boards. Posts
  are persisted atomically (temp file + rename, serialized write queue),
  so concurrent callers cannot corrupt each other's posts. Authors can
  edit (`E<n>`) and delete (`D<n>`, confirmed by typing `DELETE`) their
  own posts; edits show an `[edited <date>]` marker and both propagate
  to peers through the federation log. The 1994 archive posts are
  immutable. They cannot be edited or deleted.
- **CATACOMB**: a door game: a turn-based dungeon crawl with 20 turns a
  day, a persistent character, leveling, five depths, and a Hall of Fame.
  Defeat the Crypt Lord on depth 5 to win. Victories federate: the Hall
  of Fame shows your node's slayers and the network's, attributed per
  node.
- **Public archive**: `/archive` renders the same boards as a
  read-only web page, no login required, no write path, in the same
  phosphor vernacular. It shows exactly what the JSON API returns.
- **File area**: browse and read text files inline; from the web client
  you can also download them over HTTP. (From telnet, the board tells you
  the web address for downloads. A raw telnet session has no download
  channel, and we do not pretend otherwise.)
- **Who's online**: real concurrent sessions, across both transports,
  with per-call time tracking, plus live join/leave notices and chat
  (see above).

## Competitive position (researched 19 November 2026)

Facts below were checked against the projects' official sources on 19
November 2026. Sources: Synchronet: <https://www.synchro.net/>; Mystic
BBS: <https://www.mysticbbs.com/features.html>; ENiGMA½:
<https://github.com/NuSkooler/enigma-bbs>. DeadLine does not claim to be
the first federated BBS. Federation exists in mature BBS software, and
so does multinode chat. The claim is the *combination*, in one
zero-config package.

| | Self-host | Federation | Terminal access | Browser, no install | Zero-config start | No third-party account |
|---|---|---|---|---|---|---|
| **DeadLine BBS** | yes | yes (HTTP/JSON log) | yes (Telnet) | yes (built-in web terminal) | yes | yes |
| Synchronet (v3.21e, Mar 2026, GPLv2) | yes | yes (FidoNet/QWK/DOVE-Net) | yes | web/forum UIs, no built-in terminal | no (setup + config) | yes |
| Mystic BBS (1.12 A48, Jan 2023, proprietary freeware) | yes | yes (BINKP/BSO echomail) | yes | basic HTTP only | no (config + nodelist) | yes |
| ENiGMA½ (BSD-2-Clause, since 2015) | yes | FTN/BSO + BinkP; ActivityPub experimental | yes | no (external clients) | no (HJSON config) | yes |
| Discord | no | no | no | yes | n/a (hosted) | no |
| Discourse | yes (Docker only, 1 GB+ RAM, domain + SMTP) | no | no | yes | no | yes (self-hosted) |
| Reddit | no | no | no | yes | n/a (hosted) | no |
| Mastodon (AGPLv3) | yes (Ruby + PostgreSQL + Redis + Node + FFmpeg) | yes (ActivityPub) | no | yes | no | yes (own instance) |

**Where DeadLine wins:** no single alternative combines a faithful BBS
revival, real-time live interaction, HTTP/JSON federation with
one-environment-variable peering, `npm install && npm start` with zero
configuration, access from a telnet client to a phone browser, and
self-hosting with no third-party account or service. The closest
competitor, ENiGMA½, needs HJSON configuration and external terminal
clients, and its ActivityPub support is experimental. Mystic and
Synchronet carry decades of maturity, but their federation runs on
FidoNet-era machinery. Discord and Reddit are centralized tenants;
Discourse is a heavy web-only forum; Mastodon is federated
microblogging with a heavy stack and no terminal.

**Where DeadLine loses, honestly:** no voice, video, or images; no
native mobile app; ~~no message editing, deletion~~ (closed 19 Nov
2026: authors edit/delete their own posts, synced via the federation
log); no synchronized moderation; no email, NNTP, Gopher, or door
ecosystem; ~~passcode hashing is single-round salted SHA-256, not
PBKDF2~~ (closed 19 Nov 2026: PBKDF2-HMAC-SHA256, 600,000 iterations,
with automatic migration of legacy hashes); the federation protocol is
not compatible with FTN or ActivityPub, so it cannot interoperate with
existing networks; and it is 30 years younger than its BBS competitors,
with no community yet. Every claim in this section maps to a feature
that exists and is tested in this repo. Anything unprovable was cut.

Sources: synchro.net and Synchronet's Wikipedia entry; mysticbbs.com
features page; github.com/NuSkooler/enigma-bbs; Discourse's official
install requirements; joinmastodon.org and Mastodon's Wikipedia entry;
Discourse's Reddit comparison and independent platform comparisons. All
read 19 November 2026.

## Honest disclosures

- **The 1994 archive.** The boards ship with eight seeded threads dated
  1994, written as era-authentic starter content. Every one is labeled
  `[ARCHIVE]` in the board and carries `isArchive: true` in the data.
  They are lore, not fake users: nothing pretends to be active, and every
  post you write is real persisted data under your own handle. Seeds
  never federate.
- **The `N` key.** In a thread list, `N` always means "new thread".
  Pagination uses `>` and `<`. The screen footer says so on every page.
- **Live display limit: fixed 19 Nov 2026.** A live notice used to
  clear one terminal line, leaving fragments when partial input had
  wrapped. The frame is now width-aware: it clears every line the
  input occupies before printing the notice. Proven by frame-level
  tests and a narrow-width headless screenshot; your input buffer was
  always intact.
- **What is not here.** No XMODEM, no SSH transport, no FidoNet/FTN
  compatibility, no synchronized moderation. Those are real
  capabilities that deserve real implementations, not stubs.
- **What was not live-verified.** A standalone telnet client app
  (verified over raw TCP, not PuTTY/macOS Terminal); a physical phone
  keyboard (verified with a mobile-viewport headless browser). See
  `docs/SUBMISSION.md` for the full list.

## Architecture

```
src/
  server/     HTTP + static + downloads + public archive, telnet server,
              WebSocket bridge, live event hub
  session/    the one engine: state machine, screens, line reader
  sync/       federation: append-only log entries/store/engine, sync
              endpoint, read-only JSON API, SSE stream
  telnet/     RFC 854 negotiator, ANSI helpers
  boards/     message store, search, 1994 archive seeds
  game/       CATACOMB rules (pure, injectable RNG) + Hall of Fame scores
  users/      handles, passcode hashes, read markers
  shared/     types, Zod validation, error classes
web/          xterm.js CRT client (Vite)
files/        the file area's downloadable text files
tests/        351 tests: unit, game, CRDT convergence, real-socket live
              + federation + edit/delete integration, JSON API + SSE,
              public archive HTTP
```

The session engine is transport-agnostic: `processInput({state, input,
deps})` is the same function whether the bytes arrived over TCP or a
WebSocket. The telnet negotiator is a stateful RFC 854 parser that
tolerates split packets and only answers state changes, so negotiation
can never loop. The live hub is in-process only. It never forwards
events over sync; the sync log carries data, and applying a remote entry
publishes the same live event a local post would.

## Development

```sh
npm run verify   # typecheck + tests + production build
npm test         # vitest
npm run check    # tsc, all three configs
npm run build    # server to dist/, web client to dist/public/
```

## How Kiro was used

Kiro (via `kiro-cli`, its native interface) generated the entire
`.kiro/` folder, steering, the feature spec, and the hooks, plus the
CATACOMB game module, its 65 tests, and the shared types file. The rest
of the code, the tests, and this README were written directly by the
builder. The LIVE BOARD and FEDERATION layers were written entirely by
the builder with zero Kiro calls, as was the PRO-DEV round of 19
November 2026 (PBKDF2, edit/delete sync, federated Hall of Fame, public
archive, Node Status, accessibility pass), which left every Kiro
artifact untouched. The full, honest log, every Kiro call, what each
one produced, and what the builder wrote, is in
[`KIRO-USAGE.md`](KIRO-USAGE.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
