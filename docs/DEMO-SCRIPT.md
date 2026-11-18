# Demo video script — DeadLine BBS (Kiroween 2026)

**Preparation only — nothing here was recorded.** Target: under 3
minutes. Total shot time: 170 seconds. Every shot below shows a feature
that exists and is covered by the test suite; nothing is staged,
mocked, or faked. If a shot cannot be captured honestly in one take,
cut it — do not fake it.

## Setup (before recording)

```sh
npm install
npm run build
```

Use fresh data directories so the board shows its real first-run state.
Record the terminal and the browser at 1280×800. No secrets, no real
personal data, no `SYNC_SECRET` in view.

## Shots

| # | Shot | Time | Exact actions |
| --- | --- | --- | --- |
| 1 | Cold start + register | 15s | `npm start`. Open <http://localhost:8080>. Type a handle, set a passcode, land on the main menu. Narration: "One command. No accounts elsewhere, no keys." |
| 2 | Boards + archive + search | 20s | Menu `1`, open General Discussion, read the `[ARCHIVE - 1994]` thread. Back out, `/`, search `modem`. Narration: "Four boards, real persistence, full-text search — and the 1994 archive, honestly labeled." |
| 3 | Live broadcast, two windows | 30s | Two browser windows on the same node. Window B mid-typing a long line. Window A posts a thread. B sees the notice inline and its input redrawn intact. Narration: "A 1994 BBS was one phone line. Here, the whole board hears it — without losing what you were typing." |
| 4 | Edit + delete your own post | 25s | In a thread you authored: `E1`, keep the subject, rewrite the body, `.` — the `[edited]` marker appears. Then `D1`, type `DELETE`, the post is gone. Narration: "Authors fix their own words. Edits and deletions travel to every peer." |
| 5 | CATACOMB + Hall of Fame | 20s | Menu `3`: enter the dungeon, fight one combat round. Menu `4`: the Hall of Fame. Narration: "A real door game — twenty turns a day. Victories travel the federation log, so the Hall of Fame spans the network." Do NOT stage a victory: show real gameplay and the Hall of Fame as it stands. |
| 6 | Federation, two nodes | 30s | `./demo-federation.sh` (ports 8081/8082). Post on node A, read it on node B. Edit it on node B, see the edit on node A. Narration: "Two nodes, one environment variable each. Post on one, read it on the other — and edits follow the same log." |
| 7 | Node Status + public archive | 20s | Menu `7`: node id, peers, log entries, sync state. Then open <http://localhost:8081/archive> in a plain tab — no login — and scroll the boards. Narration: "The node tells you its own state. And anyone can read the boards without calling in." |
| 8 | Close | 10s | Terminal: `npm start` line + the tagline on screen. Narration: "DeadLine BBS — the bulletin board system that refuses to die." |

## Narration outline (full text, ~160 words)

> The bulletin board system died in 1995. DeadLine brings it back as a
> working product — one command to start, no accounts, no keys. Call
> from a telnet client or a phone browser: same board, same callers.
> Four boards with real persistence, search, and a 1994 archive that
> says what it is. A 1994 BBS was one phone line — here the whole board
> hears a post the moment it lands, without losing what you were
> typing. Authors edit and delete their own words, and the changes
> federate. The CATACOMB door game runs twenty turns a day, and
> victories travel the same log, so the Hall of Fame spans the
> network. Two nodes peer with one environment variable each; if one
> goes down, the community lives on. Anyone can read the public
> archive without calling in. DeadLine BBS — the bulletin board
> system that refuses to die.

## What NOT to show

- No staged victory, no pre-seeded scores presented as earned.
- No fake callers, no simulated traffic — every window on screen is a
  real session.
- No claims beyond the README: do not say "first federated BBS", do not
  claim a native mobile app, voice, video, or FTN/ActivityPub
  interoperability.

## Gates

Recording, editing, YouTube upload, and the Devpost link are Monch's
decisions (see `docs/SUBMISSION.md`). This file is the plan, not the
video.
