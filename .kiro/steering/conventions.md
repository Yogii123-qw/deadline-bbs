---
inclusion: always
---

# DeadLine BBS — Conventions

## 1. Product-Depth Standard

Every feature must work end to end for real. Never ship a stub, mock, or "demo mode". If something cannot be built for real within the project's constraints, it is cut from scope and documented as cut in the submission notes — it is never faked or simulated.

## 2. Security

- Passcodes are stored as salted SHA-256 hashes. Plaintext passcodes are never logged, persisted, or transmitted after the initial input read.
- Strip ANSI escape sequences from all user-supplied text before storing it or rendering it to other users.
- Reject any file path that escapes `files/` via traversal segments (`../`) or symlinks. No file outside `files/` is ever served.
- Cap message body length and input line length. Oversized input is rejected with an error, not silently truncated.
- No `eval`, `new Function`, or any other form of dynamic code execution.

## 3. Testing

Every business-logic module has unit tests covering the normal path, boundary conditions, and failure cases. Transport-level code has integration tests that run against real sockets. A change is not considered done until `npm run verify` passes in full (`tsc` check, Vitest, and Vite build).

## 4. Honesty

- All user-facing text is in English.
- `KIRO-USAGE.md` records exactly what Kiro generated and what the human builder wrote. The log is updated as work progresses and must accurately reflect the split of authorship.
- Never claim Kiro did work it did not do.
