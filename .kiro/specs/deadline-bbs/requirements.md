# DeadLine BBS — Requirements

## R1: Telnet Transport (RFC 854 IAC Negotiation)

### R1.1 Connection Establishment
WHEN a TCP client connects on `TELNET_PORT`, THE SYSTEM SHALL accept the connection and immediately begin RFC 854 IAC option negotiation.

WHEN the IAC negotiation sequence is sent, THE SYSTEM SHALL offer WILL ECHO (option 1) and WILL Suppress-Go-Ahead (option 3) so the server controls echoing and suppresses go-ahead signals.

WHEN the IAC negotiation sequence is sent, THE SYSTEM SHALL request DO Suppress-Go-Ahead (option 3) from the client.

WHEN the server wishes to know the client's terminal dimensions, THE SYSTEM SHALL send DO NAWS (option 31) to request window-size negotiation.

### R1.2 Option Negotiation Responses
WHEN the client sends WILL for an option the server accepts, THE SYSTEM SHALL respond with DO for that option.

WHEN the client sends WILL for an option the server does not accept, THE SYSTEM SHALL respond with DONT for that option.

WHEN the client sends DO for an option the server supports, THE SYSTEM SHALL respond with WILL for that option.

WHEN the client sends DO for an option the server does not support, THE SYSTEM SHALL respond with WONT for that option.

WHEN the client sends a NAWS sub-negotiation with terminal width and height, THE SYSTEM SHALL record those dimensions for the session and use them to format screen output.

### R1.3 Half-Packet Tolerance
WHEN a TCP segment arrives containing a partial IAC sequence (the sequence is split across multiple `data` events), THE SYSTEM SHALL buffer the incomplete bytes and resume parsing when subsequent bytes arrive.

WHEN a TCP segment contains multiple IAC sequences intermixed with printable data, THE SYSTEM SHALL correctly parse all sequences and pass only the printable bytes to the session engine.

### R1.4 Abrupt Disconnect
WHEN a telnet client closes the TCP socket without sending any logout command, THE SYSTEM SHALL detect the socket closure, end the session cleanly, and remove the user from the who's-online list.

WHEN a network error occurs on the telnet socket, THE SYSTEM SHALL log the error and terminate the session without crashing the server process.

---

## R2: WebSocket Bridge and Web Terminal

### R2.1 HTTP Server
WHEN a browser requests the root HTTP path (`/`), THE SYSTEM SHALL serve `web/index.html` along with the bundled JavaScript and CSS assets.

WHEN a browser requests a static asset that exists under the web build output, THE SYSTEM SHALL serve it with an appropriate `Content-Type` header.

### R2.2 WebSocket Upgrade
WHEN a browser initiates a WebSocket upgrade request on the same HTTP port, THE SYSTEM SHALL complete the WebSocket handshake and create a new session backed by the same session engine used for telnet connections.

WHEN a WebSocket connection is established, THE SYSTEM SHALL send ANSI output from the session engine as UTF-8 text frames.

WHEN the browser xterm.js client sends a text frame containing user keystrokes, THE SYSTEM SHALL pass that input string to the session engine exactly as it arrives.

### R2.3 Web Terminal Client
WHEN the web page loads, THE SYSTEM SHALL initialize an xterm.js terminal instance and connect it to the WebSocket server.

WHEN the xterm.js terminal is initialized, THE SYSTEM SHALL attach the FitAddon so the terminal resizes to fill the browser viewport.

WHEN the browser window is resized, THE SYSTEM SHALL recalculate the terminal dimensions and send the new size to the session engine so layout adapts.

### R2.4 Session Engine Parity
WHEN a user interacts through the web terminal, THE SYSTEM SHALL present an identical experience to a telnet user, including all ANSI art, prompts, and menus.

WHEN a WebSocket session disconnects, THE SYSTEM SHALL clean up the session in the same way as a telnet disconnect.

---

## R3: User Registration and Authentication

### R3.1 New User Registration
WHEN a new connection arrives and the user enters a handle that does not exist in the user store, THE SYSTEM SHALL enter the registration flow and prompt the user to choose a passcode.

WHEN the user enters a passcode during registration, THE SYSTEM SHALL prompt for confirmation by asking the user to re-enter the passcode.

WHEN the passcode and its confirmation match, THE SYSTEM SHALL generate a random salt, compute a SHA-256 hash of `salt + passcode`, and store only the salt and the hex-encoded hash — never the plaintext passcode.

WHEN the passcode and its confirmation do not match, THE SYSTEM SHALL reject the input and prompt the user to enter a new passcode.

WHEN registration succeeds, THE SYSTEM SHALL create a new user record and persist it atomically before allowing the user to proceed.

### R3.2 Returning User Login
WHEN a returning user enters their handle, THE SYSTEM SHALL prompt for their passcode.

WHEN the user submits a passcode, THE SYSTEM SHALL compute `SHA-256(stored_salt + submitted_passcode)` and compare it to the stored hash.

WHEN the hash comparison succeeds, THE SYSTEM SHALL grant the user access to the main menu.

WHEN the hash comparison fails, THE SYSTEM SHALL display an error message and return to the handle prompt, without disclosing which part of the credentials was wrong.

### R3.3 Input Validation
WHEN a user submits a handle, THE SYSTEM SHALL reject handles shorter than 2 characters or longer than 20 characters.

WHEN a user submits a handle, THE SYSTEM SHALL strip all ANSI escape sequences from it before storing or displaying it.

WHEN a user submits a passcode during registration, THE SYSTEM SHALL reject passcodes shorter than 4 characters.

WHEN a passcode is read from the terminal, THE SYSTEM SHALL NOT echo the characters back to the user.

### R3.4 Persistence Safety
WHEN a user record is written to disk, THE SYSTEM SHALL validate the written data against the Zod user schema before confirming success.

WHEN the user store file is loaded at startup and fails Zod validation, THE SYSTEM SHALL fall back to a fresh seeded state and emit a warning to the server log.

---

## R4: Message Boards

### R4.1 Board Listing
WHEN a user navigates to the message boards section, THE SYSTEM SHALL display a list of all four boards, each showing its name, topic description, and the count of unread threads for that user.

### R4.2 Thread Listing
WHEN a user selects a board, THE SYSTEM SHALL display a paginated list of threads sorted by most-recent-post-first, showing thread subject, author handle, reply count, and whether any post in the thread is unread for that user.

### R4.3 Reading Posts
WHEN a user opens a thread, THE SYSTEM SHALL display all posts in chronological order, including author handle, timestamp, and body text.

WHEN a user reads a thread, THE SYSTEM SHALL mark all posts in that thread as read for that user, updating the per-user read marker for that board.

### R4.4 Posting and Replying
WHEN a user submits a new post, THE SYSTEM SHALL create a new thread on the selected board and persist it atomically.

WHEN a user submits a reply to an existing thread, THE SYSTEM SHALL append the reply to that thread and persist the updated thread atomically.

WHEN a user submits a post or reply, THE SYSTEM SHALL strip all ANSI escape sequences from the subject and body before storing or displaying them.

WHEN a user submits a post subject, THE SYSTEM SHALL reject subjects longer than 72 characters and display an error message.

WHEN a user submits a post body, THE SYSTEM SHALL reject bodies longer than 4,096 characters and display an error message.

WHEN a post body exceeds the maximum length, THE SYSTEM SHALL NOT silently truncate it; it SHALL display an error and require the user to shorten it.

### R4.5 Per-User Read Markers
WHEN a user reads posts, THE SYSTEM SHALL record the highest post ID seen per board for that user.

WHEN a user returns to a board they have visited before, THE SYSTEM SHALL highlight posts and threads that have arrived since their last visit as new or unread.

### R4.6 Full-Text Search
WHEN a user submits a search query from the boards section, THE SYSTEM SHALL search subject lines and body text across all four boards, case-insensitively.

WHEN search results exist, THE SYSTEM SHALL display each matching post's board name, thread subject, author, and a brief excerpt.

WHEN no results match, THE SYSTEM SHALL display a clear "no results" message.

### R4.7 Archive Seed Content
WHEN the board store is initialized for the first time with no existing data, THE SYSTEM SHALL seed each board with at least one archive post dated 1994 and labeled "ARCHIVE - 1994".

WHEN archive seed content is displayed to users, THE SYSTEM SHALL present it exactly as it is stored, with the archive label visible.

---

## R5: Atomic JSON Persistence

### R5.1 Atomic Writes
WHEN any store writes data to disk, THE SYSTEM SHALL write the new content to a temporary file in the same directory as the target file first.

WHEN the temporary file has been fully written, THE SYSTEM SHALL rename it atomically over the target file so the final state is either the old file or the complete new file — never a partial write.

### R5.2 Serialized Write Queue
WHEN two concurrent sessions attempt to write to the same store file simultaneously, THE SYSTEM SHALL serialize the writes through a queue so they execute one at a time and neither write is lost.

WHEN a write operation is queued, THE SYSTEM SHALL complete all previously queued writes for that file before starting the new one.

### R5.3 Zod Validation on Load
WHEN any store file is read from disk at startup, THE SYSTEM SHALL parse the JSON and validate it against the corresponding Zod schema.

WHEN a store file fails Zod validation on load, THE SYSTEM SHALL discard the invalid data, initialize from the seeded default state, and emit a warning to the server log.

WHEN a store file does not exist on startup, THE SYSTEM SHALL initialize from the seeded default state without emitting an error.

---

## R6: Door Game — CATACOMB

### R6.1 Daily Turn Allowance
WHEN a user starts a CATACOMB session, THE SYSTEM SHALL check how many turns they have remaining for the current calendar day.

WHEN a user has zero turns remaining for the day, THE SYSTEM SHALL display a message stating when turns reset and return the user to the main menu.

WHEN a user expends a turn, THE SYSTEM SHALL decrement their remaining turn count and persist the updated count immediately.

WHEN midnight passes (server local time), THE SYSTEM SHALL reset every user's turn count to the daily maximum at the start of their next session.

### R6.2 Persistent Character
WHEN a user plays CATACOMB for the first time, THE SYSTEM SHALL create a new character record for that user with default starting stats and persist it.

WHEN a user returns to CATACOMB in a later session, THE SYSTEM SHALL load their existing character including current HP, attack, defense, level, and dungeon progress.

### R6.3 Combat
WHEN a user encounters a monster, THE SYSTEM SHALL execute a turn-based combat round: player attacks first, then the monster attacks, with damage calculated from attack and defense stats.

WHEN a combat round resolves, THE SYSTEM SHALL display the damage dealt and received, and the remaining HP of both combatants.

WHEN a monster is defeated, THE SYSTEM SHALL award experience points and optionally treasure to the player character.

### R6.4 Win Condition
WHEN the player defeats the Crypt Lord (the final boss), THE SYSTEM SHALL display a victory message, record the win on the Hall of Fame with the user's handle, final character level, and timestamp, and mark the character as victorious.

### R6.5 Lose Condition
WHEN the player's HP reaches zero, THE SYSTEM SHALL display a death message and reset the character to its starting state.

WHEN the player dies, THE SYSTEM SHALL NOT record a Hall of Fame entry for that run.

### R6.6 Hall of Fame
WHEN a user views the Hall of Fame, THE SYSTEM SHALL display all recorded victories sorted by character level descending, then by timestamp ascending.

WHEN no victories have been recorded yet, THE SYSTEM SHALL display a message indicating the Hall of Fame is empty.

### R6.7 Game State Purity
WHEN the CATACOMB game logic processes a turn, THE SYSTEM SHALL accept the current game state as input and return the new game state as output without directly reading or writing any files.

---

## R7: File Area

### R7.1 Directory Listing
WHEN a user navigates to the file area, THE SYSTEM SHALL display a list of all files in the `files/` directory showing filename, size in bytes, and a brief description where available.

### R7.2 Inline Reading
WHEN a user selects a text file for inline reading, THE SYSTEM SHALL display the file content one page at a time, pausing after each page and prompting to continue or quit.

WHEN a user selects a binary or non-text file for inline reading, THE SYSTEM SHALL display an error and decline to show the file inline.

### R7.3 HTTP Download
WHEN a web-terminal user requests a file download, THE SYSTEM SHALL serve the file over HTTP with the correct `Content-Disposition: attachment` header and the file's inferred MIME type.

WHEN a telnet user requests a file download, THE SYSTEM SHALL inform the user that direct download is available via the web interface.

### R7.4 Path-Traversal Guards
WHEN any file path is received from user input, THE SYSTEM SHALL resolve it against the `files/` base directory and reject it if the resolved path is outside `files/`.

WHEN a file path contains traversal segments such as `../`, THE SYSTEM SHALL reject it with an error message.

WHEN a requested file is a symlink that resolves to a path outside `files/`, THE SYSTEM SHALL reject the request.

WHEN a requested file does not exist in `files/`, THE SYSTEM SHALL display a "file not found" error.

---

## R8: Who's Online and Per-Call Time Tracking

### R8.1 Who's Online
WHEN a user connects and completes authentication, THE SYSTEM SHALL add their handle to the global active-sessions list.

WHEN a user views the who's-online screen, THE SYSTEM SHALL display all currently connected users with their handles and connection duration.

WHEN a user disconnects for any reason, THE SYSTEM SHALL remove them from the active-sessions list immediately.

WHEN a user views who's online and they are the only connected user, THE SYSTEM SHALL display that fact clearly rather than an empty list.

### R8.2 Per-Call Time Tracking
WHEN a session begins, THE SYSTEM SHALL record the exact connect timestamp.

WHEN a user requests elapsed time or the main menu is displayed, THE SYSTEM SHALL show the elapsed time for the current session in hours, minutes, and seconds.

WHEN a session ends, THE SYSTEM SHALL log the user's handle, connect time, disconnect time, and total session duration to the server log.

---

## R9: ANSI Art Screens and Error Messages

### R9.1 ANSI Art
WHEN the BBS displays the splash screen at connection time, THE SYSTEM SHALL render it as authentic ANSI art using ANSI escape sequences for color and cursor movement.

WHEN the BBS displays section headers (boards, file area, game, etc.), THE SYSTEM SHALL render them using ANSI art frames.

WHEN ANSI art is emitted, THE SYSTEM SHALL use standard ANSI/VT100 escape sequences compatible with both xterm.js and standard telnet clients.

### R9.2 Error Messages
WHEN any error or rejection message is displayed to the user, THE SYSTEM SHALL display it in plain English.

WHEN an internal error occurs that cannot be recovered, THE SYSTEM SHALL display a user-friendly message without exposing stack traces or internal paths.

WHEN a user submits invalid input, THE SYSTEM SHALL display a specific, actionable message describing what was wrong and what valid input looks like.

---

## R10: No Mocks, Simulations, or Fake Data

### R10.1 Real Implementation
WHEN any feature described in R1–R9 is implemented, THE SYSTEM SHALL provide a fully functional end-to-end implementation with no stubbed, mocked, or simulated behavior.

WHEN seed archive messages are added to the board store, THE SYSTEM SHALL label every archive post clearly as "ARCHIVE - 1994" so users and judges can distinguish them from live user posts.

WHEN archive posts are stored, THE SYSTEM SHALL store them using the same data schema as regular user posts, with the archive label in the author field or a dedicated flag field.

WHEN a judge tests any feature using a telnet client or browser, THE SYSTEM SHALL behave as documented in R1–R9 without requiring any special flags or modes.
