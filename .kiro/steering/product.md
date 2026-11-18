---
inclusion: always
---

# DeadLine BBS — Product

## Overview

DeadLine BBS is a real, working multi-node bulletin board system revived from the dead dial-up
era (1978-1995) using a modern stack. Built for the Kiroween 2026 hackathon, Resurrection category.
Every feature described here must actually work end to end; nothing is simulated or mocked.
## Connections

Users connect in two ways to the **same** session engine:

1. **Telnet over TCP** — RFC 854 IAC negotiation, ANSI terminal UI, any standard telnet client.
2. **Web terminal** — xterm.js over WebSocket, served over HTTP, full ANSI rendering in browser.

Both transports share one session engine. The experience is identical regardless of transport.

## Features

### Authentication

- New users register a handle and passcode at first connection.
- Passcodes stored as salted SHA-256 hashes; plaintext never logged or persisted.
- Returning users log in with handle + passcode.

### Message Boards

- Four boards with distinct topics.
- Operations: read threads, post, reply, threaded view.
- Per-user read markers track new messages since last visit.
- Full-text search across all boards.
- Atomic JSON persistence: temp-file plus rename; a crash never corrupts the store.
### Door Game: CATACOMB

- Turn-based dungeon crawl inside the BBS.
- Daily turn allowance per user, resets at midnight.
- Persistent character stats survive between sessions.
- Clear win and lose conditions.
- Hall of Fame scores visible to all users.

### File Area

- Directory listing of available files.
- Read text files inline in the terminal, paged.
- HTTP download for web-client users.
- Path-traversal guards: nothing outside `files/` is accessible.

### Who's Online

- Real-time list of connected users across all concurrent sessions.
- Updated on connect and disconnect.

### ANSI Art Screens

- Splash screen, section headers, and frames rendered as authentic ANSI art.

### Per-Call Time Tracking

- Each session records connect time; elapsed time is visible to the user and logged on disconnect.

## Non-Goals

No XMODEM, no FidoNet, no SSH transport, no paid APIs, no third-party accounts.
Everything runs locally with `npm install && npm start`.

## Seed Content

Archive messages dated 1994 are included as starter content, clearly labeled "ARCHIVE - 1994".
They populate the boards for judges and are not fake user activity.

## Judge Verification

Judges must be able to verify every feature in minutes using a plain telnet client or a browser.
