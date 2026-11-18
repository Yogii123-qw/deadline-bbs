# DeadLine BBS — Submission (Kiroween 2026, Resurrection)

**Written by the builder (not by Kiro).** Submission materials are in
English; this file is the Devpost draft plus the evidence checklist and
the gates that still need Monch.

## Devpost draft

**Title:** DeadLine BBS — The bulletin board system that refuses to die

**Tagline:** A real, working 1994 BBS — real Telnet, real ANSI, real
messages, a real door game — resurrected for the browser and the phone.

**Category:** Resurrection

**About this project:**

The bulletin board system died in 1995. The first public dial-up BBS,
CBBS, went online in February 1978; by 1994 some 60,000 BBSes served 17
million users in the US. Then cheap dial-up internet and the Mosaic
browser crashed the market in months, and BBS technology was suddenly
obsolete.

DeadLine resurrects it as a working product, not a diorama. One session
engine serves two transports: real Telnet over TCP — with genuine RFC 854
negotiation, so any standard telnet client can call in — and a web
terminal (xterm.js over WebSocket) in a phosphor-CRT shell. Callers
register handles, read and post on four message boards with real
persistence and per-user unread tracking, search every board, play the
CATACOMB door game (20 turns a day, persistent character, Hall of Fame),
browse a file area, and see who else is online — across both transports,
at the same time.

The boards ship with eight 1994 archive threads, each labeled `[ARCHIVE]`
in the UI: starter lore, honestly marked. Everything a caller posts is
real data, persisted atomically. No accounts elsewhere, no API keys, no
paid services: `npm install && npm start`, then open the page or telnet
in.

**Built with:** TypeScript, Node.js, xterm.js, WebSocket, Telnet (RFC 854),
Vite, Vitest, Zod. Built with Kiro (see below).

**How Kiro was used (honest statement):**

Kiro was used through its native interface, `kiro-cli`, in five prompts.
Kiro generated the entire `.kiro/` folder in this repo: the steering
files, the full feature spec (requirements with EARS acceptance criteria,
design, and 24 tasks in 9 waves), and the automation hooks. Kiro also
wrote the CATACOMB game module, its 65 tests, and the shared types file.
The remaining code, tests, web client, content, and documentation were
written directly by the builder. The complete call-by-call log, including
one failed call and one unprompted file Kiro created, is in
`KIRO-USAGE.md` in the repository. Nothing in `.kiro/` was hand-written
and claimed as Kiro's.

**Try it out:**

1. `npm install && npm start`
2. Open <http://localhost:8080> — type a handle, it registers on the spot.
3. Or: `telnet localhost 2323`.

**Demo video:** (to be recorded — see gates below; must be under 3
minutes, public on YouTube.)

## Evidence checklist (all verified mechanically by the builder)

- [x] 212/212 tests pass (`npm run verify`: typecheck + tests + build)
- [x] Production build passes (server + web client bundle)
- [x] Headless browser walkthrough: registration, boards, threads,
      CATACOMB, narrow-phone layout — 7 screenshots inspected
- [x] Live raw-TCP telnet session: register, read, post, who's online,
      logoff; first 12 wire bytes verified as the IAC negotiation bundle
- [x] WCAG AA contrast: 24/24 color pairs pass 4.5:1 (3:1 for UI dots)
- [x] Mock/TODO/secret greps clean over `src/` + `web/`
- [x] `/.kiro` at the repo root, tracked by git, NOT gitignored
- [x] Apache-2.0 license; no remote; no `.env`; no secrets
- [ ] Demo video (< 3 min, public YouTube) — **needs Monch**
- [ ] Public hosting — **needs Monch's decision**
- [ ] Devpost submission — **blocked by the account suspension**

## What was NOT live-verified (honest gaps)

- A standalone telnet client app (PuTTY, macOS Terminal) — verified with
  a raw-TCP script and the web terminal, not with a separate client app.
- A real phone keyboard — verified with a mobile-viewport headless
  browser, not a physical phone.
- The Kiro hooks firing — the hook files are valid and reference real npm
  scripts, but hook execution was never observed during the build.
- The live Kiro credit balance — not visible via CLI on the free plan.
  Five prompts were used; one reserve prompt was never spent.

## Monch gates, in order

1. **Public push** of this repo (currently local-only, no remote).
2. **Hosting** for the demo link.
3. **Demo video** under 3 minutes on public YouTube.
4. **Devpost submit** before Sat 5 Dec 2026 05:00 WIB — currently
   BLOCKED by the Devpost account suspension; the appeal is with Devpost.
5. **Kiro credits** — Monch handles the 4,000-credit request himself
   (his decision); request deadline Wed 2 Dec 2026 03:00 WIB.
6. **If he wins:** Required Forms / W-8BEN per the official rules.
