# DeadLine BBS: Submission (Kiroween 2026, Resurrection)

**Written by the builder (not by Kiro).** Submission materials are in
English; this file is the Devpost draft plus the evidence checklist and
the gates that still need Monch.

## Devpost draft

**Title:** DeadLine BBS: The bulletin board system that refuses to die

**Tagline:** A real, working 1994 BBS, real Telnet, real ANSI, real
messages, a real door game, resurrected with live interaction and
federation: a community board anyone can run, reachable from anything,
and owned by no one.

**Category:** Resurrection

**About this project:**

The bulletin board system died in 1995. The first public dial-up BBS,
CBBS, went online in February 1978; by 1994 some 60,000 BBSes served 17
million users in the US. Then cheap dial-up internet and the Mosaic
browser crashed the market in months, and BBS technology was suddenly
obsolete.

DeadLine resurrects it as a working product, not a diorama, and then
does two things a 1994 BBS physically could not. One session engine
serves two transports: real Telnet over TCP, with genuine RFC 854
negotiation, so any standard telnet client can call in, and a web
terminal (xterm.js over WebSocket) in a phosphor-CRT shell that works on
phones. Callers register handles, read and post on four message boards
with real persistence and per-user unread tracking, search every board,
play the CATACOMB door game (20 turns a day, persistent character, Hall
of Fame), browse a file area, and see who else is online.

First, it is **live**. A 1994 BBS was one phone line = one caller; two
callers never shared a moment. On DeadLine, a post reaches every other
connected session inline the moment it is written, a Crypt Lord victory
is announced to the whole board, callers see each other arrive and hang
up, and any caller can privately message any other caller who is
online, across transports, telnet to web, with delivery that never
clobbers what you are typing.

Second, it is **federated**. Nodes sync their boards over HTTP through
an append-only log, idempotently and loop-free, with store-and-forward:
if a node goes down, the community lives on at its peers, and a
restarted node pulls everything it missed. FidoNet's idea, reborn
without FidoNet's machinery, one environment variable peers two nodes.
A read-only JSON API and a public live event stream let outside tools
read the board without a terminal.

The federation log carries more than posts. Authors can edit and delete
their own messages, and the changes sync to every peer with
delete-wins, idempotent semantics; a Crypt Lord victory travels the
same log, so the Hall of Fame shows slayers from the whole network,
attributed per node. A Node Status screen shows the live federation
state of the node you called, and a public archive page renders the
boards for anyone, no login required. Passcodes are stored as
PBKDF2-HMAC-SHA256 hashes with per-account salts.

The boards ship with eight 1994 archive threads, each labeled `[ARCHIVE]`
in the UI: starter lore, honestly marked. Everything a caller posts is
real data, persisted atomically. No accounts elsewhere, no API keys, no
paid services, no central server: `npm install && npm start`, then open
the page or telnet in.

DeadLine does not claim to be the first federated BBS. Synchronet,
Mystic, and ENiGMA½ carry decades of maturity and real FidoNet-era
networking, and the README says so, with sources and an honest account
of where DeadLine loses (no voice/images, no native mobile app, no
synchronized moderation, no FTN/ActivityPub interoperability). What no
single alternative combines is this package:
a faithful revival, real-time live interaction, zero-config HTTP
federation, one-command start, access from a telnet client to a phone
browser, and self-hosting with no third-party account or service.

**Built with:** TypeScript, Node.js, xterm.js, WebSocket, Telnet (RFC 854),
Vite, Vitest, Zod. Built with Kiro (see below).

**How Kiro was used (honest statement):**

Kiro was used through its native interface, `kiro-cli`, in five prompts.
Kiro generated the entire `.kiro/` folder in this repo: the steering
files, the full feature spec (requirements with EARS acceptance criteria,
design, and 24 tasks in 9 waves), and the automation hooks. Kiro also
wrote the CATACOMB game module, its 65 tests, and the shared types file.
The remaining code, tests, web client, content, and documentation were
written directly by the builder, including the live and federation
layers and the PRO-DEV round of 19 November 2026 (PBKDF2, edit/delete
sync, federated Hall of Fame, public archive, Node Status,
accessibility pass), all built with zero Kiro calls and no touch to any
Kiro artifact. The complete
call-by-call log, including one failed call and one unprompted file
Kiro created, is in `KIRO-USAGE.md` in the repository. Nothing in
`.kiro/` was hand-written and claimed as Kiro's.

**Try it out:**

1. `npm install && npm start`
2. Open <http://localhost:8080>, type a handle, it registers on the spot.
3. Or: `telnet localhost 2323`.
4. Federation demo: `./demo-federation.sh` starts two peered nodes
   (ports 8081/8082, telnet 2324/2325): post on one, read it on the
   other.

**Demo video:** uploaded to public YouTube (v5, 173 s, 8 shots; https://youtu.be/IhImj3ZT95U; verified live 19 Nov 14:31 WIB: public, channel Bruno Srna, 173 s, title and description with chapters correct; file in the audit folder; shot list and narration outline in
`docs/DEMO-SCRIPT.md`; under 3 minutes, public on YouTube.)

## Evidence checklist (all verified mechanically by the builder)

- [x] 351/351 tests pass (`npm run verify`: typecheck + tests + build):
      285 from before the PRO-DEV round (one hash-format assertion
      updated for PBKDF2, disclosed in `KIRO-USAGE.md`) + 66 new:
      PBKDF2 migration, CRDT convergence, node status, edit/delete
      engine + real-socket integration, federated Hall of Fame,
      archive HTTP, width-aware live frames
- [x] Production build passes (server + web client bundle: JS 335.17 kB
      / 84.67 kB gzip, CSS 7.26 kB)
- [x] Headless browser walkthroughs: registration, boards, threads,
      CATACOMB, narrow-phone layout, 7 screenshots inspected; live
      layer: two-browser notice mid-typing, chat, mobile notice, 4
      screenshots inspected; PRO-DEV round: menu, node status, numbered
      + edited thread view, federated Hall of Fame, archive, mobile,
      narrow-width mid-typing notice, 11 screenshots inspected
- [x] Live raw-TCP telnet session: register, read, post, who's online,
      logoff; first 12 wire bytes verified as the IAC negotiation bundle
- [x] Live layer over real sockets: two telnet clients, two WebSocket
      clients, cross-transport chat both ways, pre-login silence, reply
      and victory broadcasts, two mid-typing integrity tests; PRO-DEV:
      width-aware frame clears every wrapped input line (7 frame tests)
- [x] Federation over real nodes: post A→B and B→A, offline→restart
      store-and-forward without duplicates, repeated sync without
      duplicates, 3-node ring convergence with stable counts, read API
      returning exactly what the terminal shows, SSE stream carrying
      live events but never chat messages; PRO-DEV: edit/delete +
      score entries converge over real two-node sockets, delete-wins,
      pending-queue resolution, author-only enforcement
- [x] Two-process federation demo run from the repo (both directions,
      sync log inspected), transcript kept in the audit directory
- [x] WCAG AA contrast: 24/24 color pairs pass 4.5:1 (3:1 for UI dots),
      re-run after the new layers and again after the PRO-DEV round
      (zero new colors: 21-value palette identical to HEAD)
- [x] Public archive: HTTP tests prove its content matches the JSON API
      thread-for-thread, POST/PUT → 405, HEAD works, no forms or
      scripts, user content escaped
- [x] Mock/TODO/secret greps clean over the new live + sync code
      (repo-wide grep shows only "No mocks" policy declarations in
      test-file header comments, plus the two pre-existing ones in
      test helpers); re-run over the PRO-DEV code with the same
      result, no TODO/FIXME, no secrets, no mock or simulation
      code anywhere
- [x] Kiro artifacts untouched by the new layers and the PRO-DEV round:
      `git diff` over `.kiro/`, the CATACOMB module, its tests, and
      shared types shows zero changed lines; zero `kiro-cli` calls for
      the new layers and the PRO-DEV round
- [x] `/.kiro` at the repo root, tracked by git, NOT gitignored
- [x] Apache-2.0 license; public on GitHub since 19 Nov 2026; no `.env`; no secrets
- [x] Demo video upload (< 3 min, public YouTube): **DONE 19 Nov 2026, https://youtu.be/IhImj3ZT95U (v5, 173 s, public, verified live 19 Nov 14:31 WIB)**
- [ ] Public hosting: **needs Monch's decision**
- [x] Devpost submission: **DONE 19 Nov 2026, https://devpost.com/software/deadline-bbs-the-bulletin-board-system-that-refuses-to-die (ID 1312006, account brunosrna44 / Yogi Apriyanto, category Resurrection; editable until 4 Dec 2026 17:00 EST)**

## What was NOT live-verified (honest gaps)

- A standalone telnet client app (PuTTY, macOS Terminal), verified with
  a raw-TCP script and the web terminal, not with a separate client app.
- A real phone keyboard, verified with a mobile-viewport headless
  browser, not a physical phone.
- The Kiro hooks firing, the hook files are valid and reference real npm
  scripts, but hook execution was never observed during the build.
- The live Kiro credit balance, not visible via CLI on the free plan.
  Five prompts were used; one reserve prompt was never spent.
- Federation limits (by design, disclosed in the README): no
  synchronized moderation, no FTN/ActivityPub interoperability,
  full-log exchange per round, seeds/presence/chat per-node, edit
  conflicts resolved by origin wall clock, federated scores trusting
  the peer set, and an open sync endpoint when `SYNC_SECRET` is unset.
  Edit/delete sync, formerly listed here, was closed 19 Nov 2026.
- ~~Live display limit: a notice clears one terminal line; if partial
  input wrapped onto several lines, fragments above the last line may
  remain until the next screen render~~. Fixed 19 Nov 2026: the frame
  is width-aware and clears every wrapped input line (frame tests +
  narrow-width screenshot).

## Monch gates, in order

1. **Public push** of this repo: **done 19 Nov 2026** (public on GitHub).
2. **Hosting** for the demo link.
3. **Demo video** under 3 minutes on public YouTube: **DONE 19 Nov 2026, https://youtu.be/IhImj3ZT95U (v5, 173 s, public, verified live 19 Nov 14:31 WIB)**.
4. **Devpost submit** before Sat 5 Dec 2026 05:00 WIB: **DONE 19 Nov 2026, https://devpost.com/software/deadline-bbs-the-bulletin-board-system-that-refuses-to-die (ID 1312006; editable until 4 Dec 2026 17:00 EST)**.
5. **Kiro credits**: Monch handles the 4,000-credit request himself
   (his decision); request deadline Wed 2 Dec 2026 03:00 WIB.
6. **If he wins:** Required Forms / W-8BEN per the official rules.
