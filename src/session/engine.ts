/**
 * src/session/engine.ts — Central session state machine (builder-written, per design §2.13, §3).
 *
 * processInput(state, input) -> { state, output }. The engine never touches
 * sockets, files, or timers directly: all persistence goes through the
 * stores in EngineDeps, the clock and RNG are injected, and output is a
 * plain ANSI string the transports deliver.
 *
 * Key-resolution note: the design diagram assigns 'N' both to "new thread"
 * and "next page" in THREAD_LIST. That is ambiguous, so pagination uses
 * '>' / '<' and 'N' always means "new thread". The screen states this.
 */

import { randomUUID } from 'node:crypto';
import type {
  ActiveSession,
  BoardContext,
  GameCharacter,
  Post,
  SessionState,
  Thread,
} from '../shared/types.js';
import type { BoardStore } from '../boards/boards.js';
import { comparePosts } from '../boards/boards.js';
import type { NodeStatusData } from '../sync/engine.js';
import { searchBoards } from '../boards/search.js';
import type { UserStore } from '../users/users.js';
import type { ScoreStore } from '../game/scores.js';
import type { LiveHub } from '../server/live.js';
import type { SyncLogStore } from '../sync/store.js';
import {
  DAILY_TURNS,
  checkWinCondition,
  newCharacter,
  resetCharacter,
  runCombatRound,
  startSession,
  takeTurn,
  type PlayerAction,
} from '../game/catacomb.js';
import { listFiles, readFileInline } from '../files/filearea.js';
import { sanitizeUserText } from '../telnet/ansi.js';
import { AuthError, FileAreaError, GameError, ValidationError } from '../shared/errors.js';
import {
  BODY_MAX,
  MAX_LINE,
  SUBJECT_MAX,
  validateChatMessage,
  validateHandle,
  validatePasscode,
  validatePost,
  validateSearchQuery,
  zTelnetInput,
} from '../shared/validation.js';
import {
  POSTS_PER_PAGE,
  THREADS_PER_PAGE,
  boardListScreen,
  catacombScreen,
  chatHelpScreen,
  combatScreen,
  composeScreen,
  errorScreen,
  fileListScreen,
  filePager,
  formatElapsed,
  goodbyeScreen,
  hallOfFameScreen,
  mainMenu,
  nodeStatusScreen,
  searchResultsScreen,
  splashScreen,
  threadListScreen,
  threadViewScreen,
  whoOnlineScreen,
} from './screens.js';

/**
 * Transient per-session edit/delete state (PRO-DEV amendment §6.2).
 * SessionState and BoardContext live in the Kiro-authored types file and
 * cannot gain fields, so edit targets and delete confirmations live in
 * this map on EngineDeps. A draft is only ever honored when the session
 * is in the phase and thread the draft names; anything else is stale and
 * ignored. Transports discard drafts on disconnect.
 */
export type SessionDraft =
  | {
      kind: 'edit';
      postId: string;
      threadId: string;
      boardId: string;
      originalSubject: string;
    }
  | { kind: 'delete-confirm'; postId: string; threadId: string; boardId: string };

export interface EngineDeps {
  users: UserStore;
  boards: BoardStore;
  scores: ScoreStore;
  filesDir: string;
  httpPort: number;
  activeSessions: Map<string, ActiveSession>;
  now: () => Date;
  rng: () => number;
  onLog: (message: string) => void;
  /** Live hub: when absent, the engine behaves exactly as before (no events). */
  live?: LiveHub;
  /** Sync log: when absent, local posts are not recorded for federation. */
  syncLog?: SyncLogStore;
  /** Per-session edit/delete drafts (see SessionDraft). Created lazily. */
  sessionDrafts?: Map<string, SessionDraft>;
  /** Sync stats provider for NODE STATUS; absent = federation not wired. */
  syncStats?: () => Promise<NodeStatusData>;
}

/** Drop a session's drafts (transports call this on disconnect). */
export function discardSessionDrafts(sessionId: string, deps: EngineDeps): void {
  deps.sessionDrafts?.delete(sessionId);
}

function ensureDrafts(deps: EngineDeps): Map<string, SessionDraft> {
  deps.sessionDrafts ??= new Map<string, SessionDraft>();
  return deps.sessionDrafts;
}

/** The edit draft for this session, honored only in its own context. */
function getEditDraft(deps: EngineDeps, state: SessionState): Extract<SessionDraft, { kind: 'edit' }> | undefined {
  const draft = deps.sessionDrafts?.get(state.id);
  if (draft === undefined || draft.kind !== 'edit') return undefined;
  if (state.phase !== 'COMPOSING_POST') return undefined;
  if (state.boardContext?.threadId !== draft.threadId) return undefined;
  return draft;
}

/** The delete-confirm draft for this session, honored only in its own context. */
function getDeleteDraft(
  deps: EngineDeps,
  state: SessionState,
): Extract<SessionDraft, { kind: 'delete-confirm' }> | undefined {
  const draft = deps.sessionDrafts?.get(state.id);
  if (draft === undefined || draft.kind !== 'delete-confirm') return undefined;
  if (state.phase !== 'READING_THREAD') return undefined;
  if (state.boardContext?.threadId !== draft.threadId) return undefined;
  return draft;
}

export interface EngineInput {
  state: SessionState;
  input: string;
  deps: EngineDeps;
}

export interface EngineOutput {
  state: SessionState;
  output: string;
}

export function newSession(
  transport: 'telnet' | 'websocket',
  now: Date,
): SessionState {
  return {
    id: randomUUID(),
    transport,
    phase: 'SPLASH',
    userId: null,
    handle: null,
    connectedAt: now.toISOString(),
    terminalWidth: 80,
    terminalHeight: 24,
    pendingRegistration: null,
    boardContext: null,
    gameContext: null,
    fileContext: null,
  };
}

/** Local calendar date (YYYY-MM-DD) for the daily turn rollover (R6.1). */
export function todayLocal(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyBoardContext(): BoardContext {
  return {
    boardId: null,
    threadId: null,
    page: 0,
    composingSubject: null,
    composingBody: null,
    searchQuery: null,
  };
}

function renderWidth(state: SessionState): number {
  return Math.min(200, Math.max(40, state.terminalWidth));
}

/**
 * Re-render the greeting (splash + handle prompt) at the session's current
 * width. Transports call this once, when they learn the real terminal size
 * before the user has typed anything: a narrow terminal would otherwise
 * show the 80-column splash wrapped mid-letter. Returns '' unless the
 * session is still at the handle prompt.
 */
export function redrawGreeting(state: SessionState): string {
  if (state.phase !== 'HANDLE_PROMPT') return '';
  return `${splashScreen(renderWidth(state))}\n\nHandle: `;
}

function menuState(state: SessionState): SessionState {
  return {
    ...state,
    phase: 'MAIN_MENU',
    boardContext: null,
    gameContext: null,
    fileContext: null,
  };
}

async function menuOutput(state: SessionState, deps: EngineDeps): Promise<string> {
  return mainMenu(state.handle ?? 'caller', formatElapsed(state.connectedAt, deps.now()), renderWidth(state));
}

async function unreadPostIds(
  state: SessionState,
  deps: EngineDeps,
  boardId: string,
): Promise<Set<string>> {
  const user = state.userId === null ? null : await deps.users.findById(state.userId);
  const markerId = user?.readMarkers[boardId];
  const data = await deps.boards.readData();
  // The marker resolves against raw data: a marker pointing at a deleted
  // post must still order correctly (see findPostRaw).
  const markerPost =
    markerId === undefined ? null : await deps.boards.findPostRaw(markerId);
  const ids = new Set<string>();
  for (const thread of data.threads) {
    if (thread.boardId !== boardId) continue;
    for (const post of thread.posts) {
      if (markerPost === null || comparePosts(post, markerPost) > 0) {
        ids.add(post.id);
      }
    }
  }
  return ids;
}

/** Advance the user's read marker to a thread's newest post, never backward. */
async function advanceMarker(
  state: SessionState,
  deps: EngineDeps,
  threadId: string,
): Promise<void> {
  if (state.userId === null) return;
  const thread = await deps.boards.getThread(threadId);
  const newestId = deps.boards.newestPostId(thread);
  if (newestId === null) return;
  const user = await deps.users.findById(state.userId);
  if (user === null) return;
  const markerId = user.readMarkers[thread.boardId];
  if (markerId === newestId) return;
  if (markerId !== undefined) {
    const markerPost = await deps.boards.findPostRaw(markerId);
    const newestPost = await deps.boards.findPostRaw(newestId);
    if (markerPost !== null && newestPost !== null && comparePosts(newestPost, markerPost) <= 0) {
      return;
    }
  }
  await deps.users.updateReadMarker(state.userId, thread.boardId, newestId);
}

async function boardListOutput(state: SessionState, deps: EngineDeps): Promise<string> {
  const boards = await deps.boards.listBoards();
  const user = state.userId === null ? null : await deps.users.findById(state.userId);
  const counts = await deps.boards.getUnreadCounts(user?.readMarkers ?? {});
  return boardListScreen(boards, counts, renderWidth(state));
}

async function threadListOutput(state: SessionState, deps: EngineDeps): Promise<string> {
  const ctx = state.boardContext;
  if (ctx?.boardId === null || ctx?.boardId === undefined) {
    throw new GameError('No board selected.');
  }
  const board = await deps.boards.getBoard(ctx.boardId);
  const threads = await deps.boards.listThreads(ctx.boardId);
  const unread = await unreadPostIds(state, deps, ctx.boardId);
  return threadListScreen(board, threads, unread, ctx.page, renderWidth(state));
}

async function threadViewOutput(state: SessionState, deps: EngineDeps): Promise<string> {
  const ctx = state.boardContext;
  if (ctx?.threadId === null || ctx?.threadId === undefined) {
    throw new GameError('No thread selected.');
  }
  const thread = await deps.boards.getThread(ctx.threadId);
  const data = await deps.boards.readData();
  const editedAtByPost: Record<string, string> = {};
  for (const [postId, meta] of Object.entries(data.postMeta)) {
    editedAtByPost[postId] = meta.editedAt;
  }
  return threadViewScreen(thread, ctx.page, renderWidth(state), editedAtByPost);
}

async function fileListOutput(state: SessionState, deps: EngineDeps): Promise<string> {
  const files = await listFiles(deps.filesDir);
  return fileListScreen(files, renderWidth(state));
}

async function fileViewOutput(state: SessionState, deps: EngineDeps): Promise<string> {
  const ctx = state.fileContext;
  if (ctx?.filename === null || ctx?.filename === undefined) {
    throw new GameError('No file selected.');
  }
  const content = await readFileInline(deps.filesDir, ctx.filename);
  return filePager(ctx.filename, content, ctx.page, renderWidth(state));
}

async function catacombOutput(
  state: SessionState,
  deps: EngineDeps,
  message: string,
): Promise<string> {
  if (state.userId === null) throw new GameError('Not logged in.');
  const character = await deps.users.getCharacter(state.userId);
  if (character === null) throw new GameError('No character yet.');
  return catacombScreen(
    character,
    Math.max(0, DAILY_TURNS - character.turnsUsedToday),
    message,
    renderWidth(state),
  );
}

async function hallOfFameOutput(state: SessionState, deps: EngineDeps): Promise<string> {
  const entries = await deps.scores.getHallOfFame();
  const network = await deps.scores.getNetworkScores();
  return hallOfFameScreen(entries, renderWidth(state), network);
}

function whoOnlineOutput(state: SessionState, deps: EngineDeps): string {
  const sessions = [...deps.activeSessions.values()].sort(
    (a, b) => a.connectedAt.getTime() - b.connectedAt.getTime(),
  );
  return whoOnlineScreen(sessions, deps.now(), renderWidth(state));
}

/**
 * Record a locally created post in the federation log. Never throws:
 * appendLocal logs its own failures, and a failed log append must never
 * take down a post that already stands locally.
 */
async function recordSyncEntry(
  deps: EngineDeps,
  kind: 'thread' | 'reply',
  payload: Thread | Post,
): Promise<void> {
  if (deps.syncLog === undefined) return;
  await deps.syncLog.appendLocal(kind, payload, payload.createdAt);
}

/**
 * One-shot live chat from the main menu: `6 <handle> <message>`. Bare `6`
 * shows the help screen (who is online + syntax). No new session phase:
 * the command is parsed from the raw input line (message case preserved)
 * and the caller stays at the menu. Errors throw ValidationError, which
 * processInput renders as error + menu re-render, like every other
 * recoverable menu error.
 */
async function handleChatCommand(
  state: SessionState,
  deps: EngineDeps,
  input: string,
  width: number,
): Promise<EngineOutput> {
  const next = menuState(state);
  const rest = input.trim().slice(1).trim();
  if (rest === '') {
    const sessions = [...deps.activeSessions.values()].sort(
      (a, b) => a.connectedAt.getTime() - b.connectedAt.getTime(),
    );
    return {
      state: next,
      output: `${chatHelpScreen(sessions, width)}\n${await menuOutput(next, deps)}`,
    };
  }
  const space = rest.indexOf(' ');
  const targetName = space === -1 ? rest : rest.slice(0, space);
  const rawMessage = space === -1 ? '' : rest.slice(space + 1);
  if (rawMessage.trim() === '') {
    throw new ValidationError('Usage: 6 <handle> <message> — include a message to send.');
  }
  const message = validateChatMessage(rawMessage);
  if (state.handle !== null && targetName.toLowerCase() === state.handle.toLowerCase()) {
    throw new ValidationError('You cannot chat with yourself. Pick another caller.');
  }
  const target = [...deps.activeSessions.values()].find(
    (s) => s.handle.toLowerCase() === targetName.toLowerCase(),
  );
  if (target === undefined) {
    throw new ValidationError(`${targetName} is not online right now. Use 5 to see who is online.`);
  }
  if (deps.live === undefined) {
    throw new ValidationError('Live chat is not available right now.');
  }
  const delivered = deps.live.sendTo(target.id, {
    kind: 'chat',
    fromId: state.id,
    handle: state.handle ?? 'unknown',
    message,
  });
  if (!delivered) {
    throw new ValidationError(`${target.handle} just hung up. Try again later.`);
  }
  return {
    state: next,
    output: `\n  Message sent to ${target.handle}.\n${await menuOutput(next, deps)}`,
  };
}

/**
 * One-shot NODE STATUS from the main menu: `7` prints live federation
 * state from the sync engine, then the menu. No new session phase (the
 * chat-help pattern). Errors throw ValidationError, rendered as error +
 * menu re-render like every other recoverable menu error.
 */
async function handleNodeStatus(state: SessionState, deps: EngineDeps): Promise<EngineOutput> {
  const next = menuState(state);
  if (deps.syncStats === undefined) {
    throw new ValidationError('Node status is not available right now.');
  }
  const stats = await deps.syncStats();
  return {
    state: next,
    output: `${nodeStatusScreen(stats, renderWidth(state))}\n${await menuOutput(next, deps)}`,
  };
}

/** Re-render the current phase's screen (used after recoverable errors). */
async function renderPhase(state: SessionState, deps: EngineDeps): Promise<string> {
  const width = renderWidth(state);
  switch (state.phase) {
    case 'SPLASH':
      return `${splashScreen(width)}\n\nHandle: `;
    case 'HANDLE_PROMPT':
      return 'Handle: ';
    case 'PASSCODE_PROMPT':
      return state.pendingRegistration !== null
        ? 'Choose a passcode (min 4 characters): '
        : 'Passcode: ';
    case 'CONFIRM_PASSCODE':
      return 'Re-enter passcode: ';
    case 'MAIN_MENU':
    case 'BOARDS_MENU':
      return menuOutput(state, deps);
    case 'BOARD_LIST':
      return boardListOutput(state, deps);
    case 'THREAD_LIST':
      return threadListOutput(state, deps);
    case 'READING_THREAD':
      return threadViewOutput(state, deps);
    case 'COMPOSING_POST': {
      const editDraft = getEditDraft(deps, state);
      return composeScreen(
        state.boardContext?.composingSubject === null
          ? editDraft !== undefined
            ? 'New subject (Enter keeps the current one):'
            : 'Subject:'
          : 'Message (end with .):',
        width,
        editDraft !== undefined,
      );
    }
    case 'COMPOSING_REPLY':
      return composeScreen('Message (end with .):', width);
    case 'SEARCH_PROMPT':
      return 'Search all boards.\n\nQuery: ';
    case 'SEARCH_RESULTS': {
      const query = state.boardContext?.searchQuery ?? '';
      const data = await deps.boards.readData();
      return searchResultsScreen(searchBoards(query, data), query, width);
    }
    case 'FILE_LIST':
      return fileListOutput(state, deps);
    case 'READING_FILE':
      return fileViewOutput(state, deps);
    case 'CATACOMB':
      return catacombOutput(state, deps, '');
    case 'CATACOMB_COMBAT': {
      if (state.userId === null) throw new GameError('Not logged in.');
      const character = await deps.users.getCharacter(state.userId);
      const monster = state.gameContext?.currentMonster ?? null;
      if (character === null || monster === null) {
        return catacombOutput(state, deps, '');
      }
      return combatScreen(character, monster, null, width);
    }
    case 'HALL_OF_FAME':
      return hallOfFameOutput(state, deps);
    case 'WHO_ONLINE':
      return whoOnlineOutput(state, deps);
    case 'LOGOFF':
      return goodbyeScreen(state.handle, formatElapsed(state.connectedAt, deps.now()), width);
  }
}

async function enterThread(
  state: SessionState,
  deps: EngineDeps,
  threadId: string,
): Promise<EngineOutput> {
  await advanceMarker(state, deps, threadId);
  const next: SessionState = {
    ...state,
    phase: 'READING_THREAD',
    boardContext: {
      ...(state.boardContext ?? emptyBoardContext()),
      threadId,
      page: 0,
    },
  };
  return { state: next, output: await threadViewOutput(next, deps) };
}

/** Resolve post #n of the visible thread, enforcing author-only + no-archive. */
async function resolveEditablePost(
  state: SessionState,
  deps: EngineDeps,
  ctx: BoardContext,
  n: number,
  verb: 'edit' | 'delete',
): Promise<{ post: Post; thread: Thread } | EngineOutput> {
  const thread = ctx.threadId === null ? null : await deps.boards.getThread(ctx.threadId);
  if (thread === null) throw new GameError('No thread selected.');
  const post = thread.posts[n - 1];
  const refuse = async (message: string): Promise<EngineOutput> => ({
    state,
    output: `${errorScreen(message)}\n${await threadViewOutput(state, deps)}`,
  });
  if (post === undefined) {
    return refuse(`No post #${n} in this thread.`);
  }
  if (post.isArchive) {
    return refuse(`Archive posts from 1994 cannot be ${verb === 'edit' ? 'edited' : 'deleted'}.`);
  }
  if (state.handle === null || post.authorHandle.toLowerCase() !== state.handle.toLowerCase()) {
    return refuse(`You can only ${verb} your own posts.`);
  }
  return { post, thread };
}

async function startEdit(
  state: SessionState,
  deps: EngineDeps,
  ctx: BoardContext,
  n: number,
): Promise<EngineOutput> {
  const resolved = await resolveEditablePost(state, deps, ctx, n, 'edit');
  if ('output' in resolved) return resolved;
  ensureDrafts(deps).set(state.id, {
    kind: 'edit',
    postId: resolved.post.id,
    threadId: resolved.thread.id,
    boardId: resolved.thread.boardId,
    originalSubject: resolved.post.subject,
  });
  const next: SessionState = {
    ...state,
    phase: 'COMPOSING_POST',
    boardContext: { ...ctx, composingSubject: null, composingBody: null },
  };
  return {
    state: next,
    output: composeScreen('New subject (Enter keeps the current one):', renderWidth(state), true),
  };
}

async function startDelete(
  state: SessionState,
  deps: EngineDeps,
  ctx: BoardContext,
  n: number,
): Promise<EngineOutput> {
  const resolved = await resolveEditablePost(state, deps, ctx, n, 'delete');
  if ('output' in resolved) return resolved;
  ensureDrafts(deps).set(state.id, {
    kind: 'delete-confirm',
    postId: resolved.post.id,
    threadId: resolved.thread.id,
    boardId: resolved.thread.boardId,
  });
  return {
    state,
    output: `\n  Delete your post #${n}? This cannot be undone, here or on any peer.\n  Type DELETE to confirm, or anything else to cancel.\n\nCommand: `,
  };
}

async function confirmDelete(
  state: SessionState,
  deps: EngineDeps,
  ctx: BoardContext,
  draft: Extract<SessionDraft, { kind: 'delete-confirm' }>,
): Promise<EngineOutput> {
  const post = await deps.boards.findPost(draft.postId);
  if (
    post === null ||
    state.handle === null ||
    post.authorHandle.toLowerCase() !== state.handle.toLowerCase()
  ) {
    return {
      state,
      output: `\n  That post is already gone.\n${await threadViewOutput(state, deps)}`,
    };
  }
  const at = deps.now().toISOString();
  const entryId = deps.syncLog?.createEntryId() ?? `local:${randomUUID()}`;
  const status = await deps.boards.applyTombstone({
    postId: draft.postId,
    threadId: draft.threadId,
    boardId: draft.boardId,
    authorHandle: state.handle,
    at,
    entryId,
  });
  if (status !== 'applied' && status !== 'already') {
    return {
      state,
      output: `\n  That post can no longer be deleted.\n${await threadViewOutput(state, deps)}`,
    };
  }
  if (deps.syncLog !== undefined) {
    await deps.syncLog.appendLocal(
      'tombstone',
      {
        postId: draft.postId,
        threadId: draft.threadId,
        boardId: draft.boardId,
        authorHandle: state.handle,
      },
      at,
      entryId,
    );
  }
  const board = await deps.boards.getBoard(draft.boardId);
  deps.live?.publish({
    kind: 'edit',
    fromId: state.id,
    handle: state.handle,
    boardName: board.name,
    subject: post.subject,
    action: 'deleted',
  });
  const updated = await deps.boards.getThread(draft.threadId);
  if (updated.posts.length === 0) {
    const next: SessionState = {
      ...state,
      phase: 'THREAD_LIST',
      boardContext: { ...ctx, threadId: null, page: 0 },
    };
    return {
      state: next,
      output: `\n  Post deleted. The thread is now empty.\n${await threadListOutput(next, deps)}`,
    };
  }
  const page = Math.min(ctx.page, Math.max(0, Math.ceil(updated.posts.length / POSTS_PER_PAGE) - 1));
  const next: SessionState = { ...state, boardContext: { ...ctx, page } };
  return {
    state: next,
    output: `\n  Post deleted.\n${await threadViewOutput(next, deps)}`,
  };
}

async function dispatch(
  state: SessionState,
  input: string,
  deps: EngineDeps,
): Promise<EngineOutput> {
  const cmd = input.trim().toUpperCase();
  const width = renderWidth(state);

  switch (state.phase) {
    case 'SPLASH': {
      const next: SessionState = { ...state, phase: 'HANDLE_PROMPT' };
      return { state: next, output: `${splashScreen(width)}\n\nHandle: ` };
    }

    case 'HANDLE_PROMPT': {
      if (input.trim() === '') {
        return { state, output: 'Enter a handle to log in or register.\n\nHandle: ' };
      }
      const handle = validateHandle(input);
      const existing = await deps.users.findUser(handle);
      if (existing !== null) {
        const next: SessionState = {
          ...state,
          phase: 'PASSCODE_PROMPT',
          handle: existing.handle,
          pendingRegistration: null,
        };
        return { state: next, output: 'Passcode: ' };
      }
      const next: SessionState = {
        ...state,
        phase: 'PASSCODE_PROMPT',
        handle,
        pendingRegistration: { handle, firstPasscode: null },
      };
      return {
        state: next,
        output: `New handle. Welcome, ${handle}.\nChoose a passcode (min 4 characters): `,
      };
    }

    case 'PASSCODE_PROMPT': {
      if (input === '') {
        return { state, output: 'Passcode must not be empty.\nPasscode: ' };
      }
      const pending = state.pendingRegistration;
      if (pending !== null) {
        validatePasscode(input);
        const next: SessionState = {
          ...state,
          phase: 'CONFIRM_PASSCODE',
          pendingRegistration: { handle: pending.handle, firstPasscode: input },
        };
        return { state: next, output: 'Re-enter passcode: ' };
      }
      if (state.handle === null) {
        const next: SessionState = { ...state, phase: 'HANDLE_PROMPT' };
        return { state: next, output: 'Handle: ' };
      }
      try {
        const user = await deps.users.authenticate(state.handle, input, deps.now());
        deps.activeSessions.set(state.id, {
          id: state.id,
          handle: user.handle,
          transport: state.transport,
          connectedAt: new Date(state.connectedAt),
        });
        deps.live?.publish({
          kind: 'join',
          fromId: state.id,
          handle: user.handle,
          transport: state.transport,
        });
        const next = menuState({ ...state, userId: user.id, handle: user.handle });
        return { state: next, output: await menuOutput(next, deps) };
      } catch (err) {
        if (err instanceof AuthError) {
          const next: SessionState = {
            ...state,
            phase: 'HANDLE_PROMPT',
            handle: null,
            pendingRegistration: null,
          };
          return { state: next, output: `${errorScreen(err.message)}\nHandle: ` };
        }
        throw err;
      }
    }

    case 'CONFIRM_PASSCODE': {
      const pending = state.pendingRegistration;
      if (pending === null || pending.firstPasscode === null) {
        const next: SessionState = { ...state, phase: 'HANDLE_PROMPT', handle: null };
        return { state: next, output: 'Handle: ' };
      }
      if (input !== pending.firstPasscode) {
        const next: SessionState = {
          ...state,
          phase: 'HANDLE_PROMPT',
          handle: null,
          pendingRegistration: null,
        };
        return {
          state: next,
          output: `${errorScreen('Passcodes did not match. Starting over.')}\nHandle: `,
        };
      }
      const user = await deps.users.createUser(pending.handle, input, deps.now());
      deps.activeSessions.set(state.id, {
        id: state.id,
        handle: user.handle,
        transport: state.transport,
        connectedAt: new Date(state.connectedAt),
      });
      deps.live?.publish({
        kind: 'join',
        fromId: state.id,
        handle: user.handle,
        transport: state.transport,
      });
      const next = menuState({
        ...state,
        userId: user.id,
        handle: user.handle,
        pendingRegistration: null,
      });
      return {
        state: next,
        output: `\n  Account created. Welcome to DeadLine, ${user.handle}.\n${await menuOutput(next, deps)}`,
      };
    }

    case 'MAIN_MENU':
    case 'BOARDS_MENU': {
      if (cmd === '') {
        const next = menuState(state);
        return { state: next, output: await menuOutput(next, deps) };
      }
      if (cmd === '1') {
        const next: SessionState = {
          ...state,
          phase: 'BOARD_LIST',
          boardContext: emptyBoardContext(),
        };
        return { state: next, output: await boardListOutput(next, deps) };
      }
      if (cmd === '2') {
        const next: SessionState = {
          ...state,
          phase: 'FILE_LIST',
          fileContext: { filename: null, page: 0 },
        };
        return { state: next, output: await fileListOutput(next, deps) };
      }
      if (cmd === '3') {
        if (state.userId === null) throw new GameError('Not logged in.');
        const today = todayLocal(deps.now());
        let character: GameCharacter | null = await deps.users.getCharacter(state.userId);
        if (character === null) {
          character = newCharacter(state.userId, today);
        }
        const started = startSession(character, today);
        await deps.users.saveCharacter(state.userId, started.character);
        if (!started.canPlay) {
          const next = menuState(state);
          return {
            state: next,
            output: `${errorScreen(started.message)}\n${await menuOutput(next, deps)}`,
          };
        }
        const next: SessionState = {
          ...state,
          phase: 'CATACOMB',
          gameContext: { currentMonster: null },
        };
        return { state: next, output: await catacombOutput(next, deps, started.message) };
      }
      if (cmd === '4') {
        const next: SessionState = { ...state, phase: 'HALL_OF_FAME' };
        return { state: next, output: await hallOfFameOutput(next, deps) };
      }
      if (cmd === '5') {
        const next: SessionState = { ...state, phase: 'WHO_ONLINE' };
        return { state: next, output: whoOnlineOutput(next, deps) };
      }
      if (cmd === '6' || cmd.startsWith('6 ')) {
        return handleChatCommand(state, deps, input, width);
      }
      if (cmd === '7') {
        return handleNodeStatus(state, deps);
      }
      if (cmd === 'G') {
        const next: SessionState = { ...state, phase: 'LOGOFF' };
        return {
          state: next,
          output: goodbyeScreen(state.handle, formatElapsed(state.connectedAt, deps.now()), width),
        };
      }
      const next = menuState(state);
      return {
        state: next,
        output: `${errorScreen('Unknown choice. Pick 1-7 or G.')}\n${await menuOutput(next, deps)}`,
      };
    }

    case 'BOARD_LIST': {
      if (cmd === 'Q') {
        const next = menuState(state);
        return { state: next, output: await menuOutput(next, deps) };
      }
      if (cmd === '/') {
        const next: SessionState = {
          ...state,
          phase: 'SEARCH_PROMPT',
          boardContext: { ...(state.boardContext ?? emptyBoardContext()), searchQuery: null },
        };
        return { state: next, output: 'Search all boards.\n\nQuery: ' };
      }
      if (cmd === '') {
        return { state, output: await boardListOutput(state, deps) };
      }
      const boards = await deps.boards.listBoards();
      const n = Number.parseInt(cmd, 10);
      if (!Number.isInteger(n) || n < 1 || n > boards.length) {
        return {
          state,
          output: `${errorScreen('Pick a board number, / to search, or Q for the main menu.')}\n${await boardListOutput(state, deps)}`,
        };
      }
      const next: SessionState = {
        ...state,
        phase: 'THREAD_LIST',
        boardContext: { ...emptyBoardContext(), boardId: boards[n - 1].id },
      };
      return { state: next, output: await threadListOutput(next, deps) };
    }

    case 'THREAD_LIST': {
      const ctx = state.boardContext ?? emptyBoardContext();
      if (cmd === 'Q') {
        const next: SessionState = { ...state, phase: 'BOARD_LIST', boardContext: ctx };
        return { state: next, output: await boardListOutput(next, deps) };
      }
      if (cmd === 'N') {
        const next: SessionState = {
          ...state,
          phase: 'COMPOSING_POST',
          boardContext: { ...ctx, composingSubject: null, composingBody: null },
        };
        return { state: next, output: composeScreen('Subject:', width) };
      }
      if (cmd === '>') {
        const threads = ctx.boardId === null ? [] : await deps.boards.listThreads(ctx.boardId);
        const totalPages = Math.max(1, Math.ceil(threads.length / THREADS_PER_PAGE));
        const next: SessionState = {
          ...state,
          boardContext: { ...ctx, page: Math.min(ctx.page + 1, totalPages - 1) },
        };
        return { state: next, output: await threadListOutput(next, deps) };
      }
      if (cmd === '<') {
        const next: SessionState = {
          ...state,
          boardContext: { ...ctx, page: Math.max(0, ctx.page - 1) },
        };
        return { state: next, output: await threadListOutput(next, deps) };
      }
      if (cmd === '') {
        return { state, output: await threadListOutput(state, deps) };
      }
      const threads = ctx.boardId === null ? [] : await deps.boards.listThreads(ctx.boardId);
      const n = Number.parseInt(cmd, 10);
      if (!Number.isInteger(n) || n < 1 || n > threads.length) {
        return {
          state,
          output: `${errorScreen('Pick a thread number, N for a new thread, or Q to go back.')}\n${await threadListOutput(state, deps)}`,
        };
      }
      return enterThread(state, deps, threads[n - 1].id);
    }

    case 'READING_THREAD': {
      const ctx = state.boardContext ?? emptyBoardContext();
      // A pending delete confirmation consumes the next input wholesale:
      // DELETE confirms, anything else cancels.
      const pendingDelete = getDeleteDraft(deps, state);
      if (pendingDelete !== undefined) {
        deps.sessionDrafts?.delete(state.id);
        if (cmd === 'DELETE') {
          return confirmDelete(state, deps, ctx, pendingDelete);
        }
        return {
          state,
          output: `\n  Delete cancelled.\n${await threadViewOutput(state, deps)}`,
        };
      }
      if (cmd === 'Q') {
        const next: SessionState = {
          ...state,
          phase: 'THREAD_LIST',
          boardContext: { ...ctx, threadId: null },
        };
        return { state: next, output: await threadListOutput(next, deps) };
      }
      if (cmd === 'R') {
        const next: SessionState = {
          ...state,
          phase: 'COMPOSING_REPLY',
          boardContext: { ...ctx, composingSubject: null, composingBody: null },
        };
        return { state: next, output: composeScreen('Message (end with .):', width) };
      }
      const editMatch = /^E\s*(\d+)$/.exec(cmd);
      if (editMatch !== null) {
        return startEdit(state, deps, ctx, Number.parseInt(editMatch[1], 10));
      }
      const deleteMatch = /^D\s*(\d+)$/.exec(cmd);
      if (deleteMatch !== null) {
        return startDelete(state, deps, ctx, Number.parseInt(deleteMatch[1], 10));
      }
      if (cmd === '' || cmd === ' ') {
        const thread = ctx.threadId === null ? null : await deps.boards.getThread(ctx.threadId);
        const totalPages = Math.max(
          1,
          Math.ceil((thread?.posts.length ?? 0) / POSTS_PER_PAGE),
        );
        const next: SessionState = {
          ...state,
          boardContext: { ...ctx, page: Math.min(ctx.page + 1, totalPages - 1) },
        };
        return { state: next, output: await threadViewOutput(next, deps) };
      }
      return {
        state,
        output: `${errorScreen('Enter: more · R: reply · E<n>: edit · D<n>: delete · Q: back.')}\n${await threadViewOutput(state, deps)}`,
      };
    }

    case 'COMPOSING_POST': {
      const ctx = state.boardContext ?? emptyBoardContext();
      const editDraft = getEditDraft(deps, state);
      if (ctx.composingSubject === null) {
        if (input.trim() === '') {
          if (editDraft !== undefined) {
            // Editing: an empty subject line keeps the current subject.
            const next: SessionState = {
              ...state,
              boardContext: { ...ctx, composingSubject: editDraft.originalSubject },
            };
            return { state: next, output: composeScreen('Message (end with .):', width, true) };
          }
          const next: SessionState = {
            ...state,
            phase: 'THREAD_LIST',
            boardContext: { ...ctx, composingSubject: null, composingBody: null },
          };
          return { state: next, output: await threadListOutput(next, deps) };
        }
        if (input.trim().length > SUBJECT_MAX) {
          return {
            state,
            output: `${errorScreen(`Subject must be at most ${SUBJECT_MAX} characters.`)}\n${composeScreen(editDraft !== undefined ? 'New subject (Enter keeps the current one):' : 'Subject:', width, editDraft !== undefined)}`,
          };
        }
        const next: SessionState = {
          ...state,
          boardContext: { ...ctx, composingSubject: input.trim() },
        };
        return { state: next, output: composeScreen('Message (end with .):', width, editDraft !== undefined) };
      }
      return composeBody(state, deps, ctx, input, false, editDraft);
    }

    case 'COMPOSING_REPLY': {
      const ctx = state.boardContext ?? emptyBoardContext();
      return composeBody(state, deps, ctx, input, true);
    }

    case 'SEARCH_PROMPT': {
      if (input.trim() === '') {
        const next: SessionState = { ...state, phase: 'BOARD_LIST' };
        return { state: next, output: await boardListOutput(next, deps) };
      }
      const query = validateSearchQuery(input);
      const data = await deps.boards.readData();
      const next: SessionState = {
        ...state,
        phase: 'SEARCH_RESULTS',
        boardContext: { ...(state.boardContext ?? emptyBoardContext()), searchQuery: query },
      };
      return {
        state: next,
        output: searchResultsScreen(searchBoards(query, data), query, width),
      };
    }

    case 'SEARCH_RESULTS': {
      if (cmd === 'Q') {
        const next: SessionState = { ...state, phase: 'BOARD_LIST' };
        return { state: next, output: await boardListOutput(next, deps) };
      }
      if (cmd === '') {
        return { state, output: await renderPhase(state, deps) };
      }
      const query = state.boardContext?.searchQuery ?? '';
      const data = await deps.boards.readData();
      const results = searchBoards(query, data);
      const n = Number.parseInt(cmd, 10);
      if (!Number.isInteger(n) || n < 1 || n > results.length) {
        return {
          state,
          output: `${errorScreen('Pick a result number or Q to go back.')}\n${searchResultsScreen(results, query, width)}`,
        };
      }
      return enterThread(
        { ...state, boardContext: { ...(state.boardContext ?? emptyBoardContext()), boardId: results[n - 1].boardId } },
        deps,
        results[n - 1].threadId,
      );
    }

    case 'FILE_LIST': {
      if (cmd === 'Q') {
        const next = menuState(state);
        return { state: next, output: await menuOutput(next, deps) };
      }
      if (cmd === '') {
        return { state, output: await fileListOutput(state, deps) };
      }
      const downloadMatch = /^D(\d+)$/.exec(cmd);
      const files = await listFiles(deps.filesDir);
      if (downloadMatch !== null) {
        const n = Number.parseInt(downloadMatch[1], 10);
        if (!Number.isInteger(n) || n < 1 || n > files.length) {
          return {
            state,
            output: `${errorScreen('No such file number.')}\n${await fileListOutput(state, deps)}`,
          };
        }
        const name = files[n - 1].name;
        const message =
          state.transport === 'websocket'
            ? `  Download: /files/${encodeURIComponent(name)}\n  Open that address in your browser (same host as this page).\n`
            : `  Direct downloads need the web interface.\n  Open this server in a browser (HTTP port ${deps.httpPort}) and use D<number> there.\n`;
        return { state, output: `${message}\n${await fileListOutput(state, deps)}` };
      }
      const n = Number.parseInt(cmd, 10);
      if (!Number.isInteger(n) || n < 1 || n > files.length) {
        return {
          state,
          output: `${errorScreen('Pick a file number, D<number> to download, or Q for the main menu.')}\n${await fileListOutput(state, deps)}`,
        };
      }
      const next: SessionState = {
        ...state,
        phase: 'READING_FILE',
        fileContext: { filename: files[n - 1].name, page: 0 },
      };
      return { state: next, output: await fileViewOutput(next, deps) };
    }

    case 'READING_FILE': {
      const ctx = state.fileContext ?? { filename: null, page: 0 };
      if (cmd === 'Q') {
        const next: SessionState = { ...state, phase: 'FILE_LIST', fileContext: null };
        return { state: next, output: await fileListOutput(next, deps) };
      }
      if (cmd === '' || cmd === ' ') {
        if (ctx.filename === null) throw new GameError('No file selected.');
        const content = await readFileInline(deps.filesDir, ctx.filename);
        const totalPages = Math.max(1, Math.ceil(content.replace(/\n$/, '').split('\n').length / 20));
        const next: SessionState = {
          ...state,
          fileContext: { ...ctx, page: Math.min(ctx.page + 1, totalPages - 1) },
        };
        return { state: next, output: await fileViewOutput(next, deps) };
      }
      return {
        state,
        output: `${errorScreen('Enter: more · Q: back to file list.')}\n${await fileViewOutput(state, deps)}`,
      };
    }

    case 'CATACOMB': {
      if (cmd === 'Q') {
        const next = menuState(state);
        return { state: next, output: await menuOutput(next, deps) };
      }
      if (cmd === 'S' || cmd === '') {
        return { state, output: await catacombOutput(state, deps, '') };
      }
      const action = { E: 'explore', D: 'descend', R: 'rest' }[cmd] as PlayerAction | undefined;
      if (action === undefined) {
        return {
          state,
          output: `${errorScreen('E: explore · D: descend · R: rest · Q: leave.')}\n${await catacombOutput(state, deps, '')}`,
        };
      }
      if (state.userId === null) throw new GameError('Not logged in.');
      const character = await deps.users.getCharacter(state.userId);
      if (character === null) throw new GameError('No character yet.');
      const result = takeTurn(character, action, deps.rng);
      await deps.users.saveCharacter(state.userId, result.character);
      if (result.enteredCombat && result.monster !== null) {
        const next: SessionState = {
          ...state,
          phase: 'CATACOMB_COMBAT',
          gameContext: { currentMonster: result.monster },
        };
        return {
          state: next,
          output: `  ${result.message}\n${combatScreen(result.character, result.monster, null, width)}`,
        };
      }
      if (result.turnsRemaining <= 0) {
        const next = menuState(state);
        return {
          state: next,
          output: `\n  ${result.message}\n${await menuOutput(next, deps)}`,
        };
      }
      return { state, output: await catacombOutput(state, deps, result.message) };
    }

    case 'CATACOMB_COMBAT': {
      const monster = state.gameContext?.currentMonster ?? null;
      if (cmd === 'F' || cmd === 'Q') {
        const next: SessionState = {
          ...state,
          phase: 'CATACOMB',
          gameContext: { currentMonster: null },
        };
        return {
          state: next,
          output: await catacombOutput(next, deps, 'You slip away from the fight.'),
        };
      }
      if (cmd === 'S' || cmd === '') {
        return { state, output: await renderPhase(state, deps) };
      }
      if (cmd !== 'A') {
        return {
          state,
          output: `${errorScreen('A: attack · F: flee.')}\n${await renderPhase(state, deps)}`,
        };
      }
      if (state.userId === null) throw new GameError('Not logged in.');
      const character = await deps.users.getCharacter(state.userId);
      if (character === null || monster === null) throw new GameError('No fight is running.');
      const result = runCombatRound(character, monster, deps.rng);
      if (result.monsterDefeated && checkWinCondition(monster)) {
        const victorious: GameCharacter = { ...result.character, isVictorious: true };
        await deps.users.saveCharacter(state.userId, victorious);
        await deps.scores.recordVictory(state.handle ?? 'unknown', victorious.level, deps.now());
        deps.live?.publish({
          kind: 'victory',
          fromId: state.id,
          handle: state.handle ?? 'unknown',
          level: victorious.level,
        });
        // Federated Hall of Fame (PRO-DEV): the victory flows through the
        // same sync log as posts, via the seam above — the game module
        // itself is untouched. A failed append never blocks the victory.
        if (deps.syncLog !== undefined) {
          await deps.syncLog.appendLocal(
            'score',
            { handle: state.handle ?? 'unknown', level: victorious.level },
            deps.now().toISOString(),
          );
        }
        const next: SessionState = {
          ...state,
          phase: 'HALL_OF_FAME',
          gameContext: { currentMonster: null },
        };
        return {
          state: next,
          output: `\n  ${result.message}\n  ${boldVictory()}\n${await hallOfFameOutput(next, deps)}`,
        };
      }
      await deps.users.saveCharacter(state.userId, result.character);
      if (result.playerDefeated) {
        const fresh = resetCharacter(result.character);
        await deps.users.saveCharacter(state.userId, fresh);
        const next: SessionState = {
          ...state,
          phase: 'CATACOMB',
          gameContext: { currentMonster: null },
        };
        return {
          state: next,
          output: await catacombOutput(
            next,
            deps,
            `${result.message} You wake at the dungeon entrance, starting over.`,
          ),
        };
      }
      if (result.monsterDefeated) {
        const next: SessionState = {
          ...state,
          phase: 'CATACOMB',
          gameContext: { currentMonster: null },
        };
        return { state: next, output: await catacombOutput(next, deps, result.message) };
      }
      const next: SessionState = {
        ...state,
        gameContext: { currentMonster: result.monster },
      };
      return {
        state: next,
        output: combatScreen(result.character, result.monster, result, width),
      };
    }

    case 'HALL_OF_FAME':
    case 'WHO_ONLINE': {
      const next = menuState(state);
      return { state: next, output: await menuOutput(next, deps) };
    }

    case 'LOGOFF': {
      return { state, output: '' };
    }
  }
}

function boldVictory(): string {
  return 'VICTORY! The Crypt Lord falls. Your name enters the Hall of Fame.';
}

/** Shared body-composition flow for new posts, replies, and edits. */
async function composeBody(
  state: SessionState,
  deps: EngineDeps,
  ctx: BoardContext,
  input: string,
  isReply: boolean,
  editDraft?: Extract<SessionDraft, { kind: 'edit' }>,
): Promise<EngineOutput> {
  const width = renderWidth(state);
  const trimmed = input.trim();
  if (trimmed === '.') {
    const body = ctx.composingBody ?? '';
    if (editDraft !== undefined) {
      return finishEdit(state, deps, ctx, editDraft, body);
    }
    if (isReply) {
      if (ctx.threadId === null) throw new GameError('No thread selected.');
      const thread = await deps.boards.getThread(ctx.threadId);
      validatePost(thread.subject, body);
      const post = await deps.boards.replyToThread(ctx.threadId, state.handle ?? 'unknown', body, deps.now());
      await recordSyncEntry(deps, 'reply', post);
      const board = await deps.boards.getBoard(thread.boardId);
      deps.live?.publish({
        kind: 'post',
        fromId: state.id,
        handle: state.handle ?? 'unknown',
        boardName: board.name,
        subject: thread.subject,
        isReply: true,
      });
      const updated = await deps.boards.getThread(ctx.threadId);
      const lastPage = Math.max(
        0,
        Math.ceil(updated.posts.length / POSTS_PER_PAGE) - 1,
      );
      const next: SessionState = {
        ...state,
        phase: 'READING_THREAD',
        boardContext: { ...ctx, composingSubject: null, composingBody: null, page: lastPage },
      };
      return {
        state: next,
        output: `\n  Reply posted.\n${await threadViewOutput(next, deps)}`,
      };
    }
    if (ctx.boardId === null || ctx.composingSubject === null) {
      throw new GameError('Nothing to post.');
    }
    const thread = await deps.boards.createThread(
      ctx.boardId,
      state.handle ?? 'unknown',
      ctx.composingSubject,
      body,
      deps.now(),
    );
    await recordSyncEntry(deps, 'thread', thread);
    const board = await deps.boards.getBoard(ctx.boardId);
    deps.live?.publish({
      kind: 'post',
      fromId: state.id,
      handle: state.handle ?? 'unknown',
      boardName: board.name,
      subject: thread.subject,
      isReply: false,
    });
    const next: SessionState = {
      ...state,
      phase: 'THREAD_LIST',
      boardContext: { ...ctx, composingSubject: null, composingBody: null, page: 0 },
    };
    return {
      state: next,
      output: `\n  Thread posted.\n${await threadListOutput(next, deps)}`,
    };
  }
  if (trimmed === 'ABORT') {
    if (editDraft !== undefined) {
      deps.sessionDrafts?.delete(state.id);
      const next: SessionState = {
        ...state,
        phase: 'READING_THREAD',
        boardContext: { ...ctx, composingSubject: null, composingBody: null },
      };
      return { state: next, output: await threadViewOutput(next, deps) };
    }
    if (isReply) {
      const next: SessionState = {
        ...state,
        phase: 'READING_THREAD',
        boardContext: { ...ctx, composingSubject: null, composingBody: null },
      };
      return { state: next, output: await threadViewOutput(next, deps) };
    }
    const next: SessionState = {
      ...state,
      phase: 'THREAD_LIST',
      boardContext: { ...ctx, composingSubject: null, composingBody: null },
    };
    return { state: next, output: await threadListOutput(next, deps) };
  }
  const candidate =
    ctx.composingBody === null ? input : `${ctx.composingBody}\n${input}`;
  if (candidate.length > BODY_MAX) {
    return {
      state,
      output: `${errorScreen(`Message is at the ${BODY_MAX}-character limit. End with . or ABORT.`)}\n${composeScreen('Message (end with .):', width, editDraft !== undefined)}`,
    };
  }
  const next: SessionState = {
    ...state,
    boardContext: { ...ctx, composingBody: candidate },
  };
  return { state: next, output: '' };
}

/** Apply a finished edit: board store first, then the federation log. */
async function finishEdit(
  state: SessionState,
  deps: EngineDeps,
  ctx: BoardContext,
  draft: Extract<SessionDraft, { kind: 'edit' }>,
  body: string,
): Promise<EngineOutput> {
  const clean = validatePost(ctx.composingSubject ?? draft.originalSubject, body);
  const at = deps.now().toISOString();
  const entryId = deps.syncLog?.createEntryId() ?? `local:${randomUUID()}`;
  const status = await deps.boards.applyEdit({
    postId: draft.postId,
    threadId: draft.threadId,
    boardId: draft.boardId,
    authorHandle: state.handle ?? 'unknown',
    subject: clean.subject,
    body: clean.body,
    at,
    entryId,
  });
  deps.sessionDrafts?.delete(state.id);
  if (status !== 'applied' && status !== 'superseded') {
    const next: SessionState = {
      ...state,
      phase: 'READING_THREAD',
      boardContext: { ...ctx, composingSubject: null, composingBody: null },
    };
    return {
      state: next,
      output: `\n  That post can no longer be edited.\n${await threadViewOutput(next, deps)}`,
    };
  }
  if (deps.syncLog !== undefined) {
    await deps.syncLog.appendLocal(
      'edit',
      {
        postId: draft.postId,
        threadId: draft.threadId,
        boardId: draft.boardId,
        authorHandle: state.handle ?? 'unknown',
        subject: clean.subject,
        body: clean.body,
      },
      at,
      entryId,
    );
  }
  const board = await deps.boards.getBoard(draft.boardId);
  deps.live?.publish({
    kind: 'edit',
    fromId: state.id,
    handle: state.handle ?? 'unknown',
    boardName: board.name,
    subject: clean.subject,
    action: 'edited',
  });
  const updated = await deps.boards.getThread(draft.threadId);
  const idx = updated.posts.findIndex((p) => p.id === draft.postId);
  const page = idx === -1 ? 0 : Math.floor(idx / POSTS_PER_PAGE);
  const next: SessionState = {
    ...state,
    phase: 'READING_THREAD',
    boardContext: { ...ctx, composingSubject: null, composingBody: null, page },
  };
  const note =
    status === 'applied'
      ? 'Post edited.'
      : 'Post edited — but a newer edit from the network already stands.';
  return {
    state: next,
    output: `\n  ${note}\n${await threadViewOutput(next, deps)}`,
  };
}

export async function processInput(ctx: EngineInput): Promise<EngineOutput> {
  const { deps } = ctx;
  const cleanInput = sanitizeUserText(ctx.input);
  try {
    const parsed = zTelnetInput.safeParse(cleanInput);
    if (!parsed.success) {
      throw new ValidationError(`Input line is too long (max ${MAX_LINE} characters).`);
    }
    return await dispatch(ctx.state, cleanInput, deps);
  } catch (err) {
    if (err instanceof AuthError) {
      const next: SessionState = {
        ...ctx.state,
        phase: 'HANDLE_PROMPT',
        handle: null,
        pendingRegistration: null,
      };
      return { state: next, output: `${errorScreen(err.message)}\nHandle: ` };
    }
    if (
      err instanceof ValidationError ||
      err instanceof FileAreaError ||
      err instanceof GameError
    ) {
      let screen: string;
      try {
        screen = await renderPhase(ctx.state, deps);
      } catch {
        const next = menuState(ctx.state);
        return {
          state: next,
          output: `${errorScreen(err.message)}\n${await menuOutput(next, deps)}`,
        };
      }
      return { state: ctx.state, output: `${errorScreen(err.message)}\n${screen}` };
    }
    deps.onLog(
      `ERROR processing input in phase ${ctx.state.phase}: ${err instanceof Error ? err.message : String(err)}`,
    );
    const next = menuState(ctx.state);
    return {
      state: next,
      output: `${errorScreen('A system error occurred. Returning to the main menu.')}\n${await menuOutput(next, deps)}`,
    };
  }
}
