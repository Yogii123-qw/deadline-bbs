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
  SessionState,
} from '../shared/types.js';
import type { BoardStore } from '../boards/boards.js';
import { comparePosts } from '../boards/boards.js';
import { searchBoards } from '../boards/search.js';
import type { UserStore } from '../users/users.js';
import type { ScoreStore } from '../game/scores.js';
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
  combatScreen,
  composeScreen,
  errorScreen,
  fileListScreen,
  filePager,
  formatElapsed,
  goodbyeScreen,
  hallOfFameScreen,
  mainMenu,
  searchResultsScreen,
  splashScreen,
  threadListScreen,
  threadViewScreen,
  whoOnlineScreen,
} from './screens.js';

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
  const markerPost =
    markerId === undefined
      ? null
      : data.threads.flatMap((t) => t.posts).find((p) => p.id === markerId) ?? null;
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
    const markerPost = await deps.boards.findPost(markerId);
    const newestPost = await deps.boards.findPost(newestId);
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
  return threadViewScreen(thread, ctx.page, renderWidth(state));
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
  return hallOfFameScreen(entries, renderWidth(state));
}

function whoOnlineOutput(state: SessionState, deps: EngineDeps): string {
  const sessions = [...deps.activeSessions.values()].sort(
    (a, b) => a.connectedAt.getTime() - b.connectedAt.getTime(),
  );
  return whoOnlineScreen(sessions, deps.now(), renderWidth(state));
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
    case 'COMPOSING_POST':
      return composeScreen(
        state.boardContext?.composingSubject === null ? 'Subject:' : 'Message (end with .):',
        width,
      );
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
        output: `${errorScreen('Unknown choice. Pick 1-5 or G.')}\n${await menuOutput(next, deps)}`,
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
        output: `${errorScreen('Enter: more · R: reply · Q: back.')}\n${await threadViewOutput(state, deps)}`,
      };
    }

    case 'COMPOSING_POST': {
      const ctx = state.boardContext ?? emptyBoardContext();
      if (ctx.composingSubject === null) {
        if (input.trim() === '') {
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
            output: `${errorScreen(`Subject must be at most ${SUBJECT_MAX} characters.`)}\n${composeScreen('Subject:', width)}`,
          };
        }
        const next: SessionState = {
          ...state,
          boardContext: { ...ctx, composingSubject: input.trim() },
        };
        return { state: next, output: composeScreen('Message (end with .):', width) };
      }
      return composeBody(state, deps, ctx, input, false);
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

/** Shared body-composition flow for new posts and replies. */
async function composeBody(
  state: SessionState,
  deps: EngineDeps,
  ctx: BoardContext,
  input: string,
  isReply: boolean,
): Promise<EngineOutput> {
  const width = renderWidth(state);
  const trimmed = input.trim();
  if (trimmed === '.') {
    const body = ctx.composingBody ?? '';
    if (isReply) {
      if (ctx.threadId === null) throw new GameError('No thread selected.');
      const thread = await deps.boards.getThread(ctx.threadId);
      validatePost(thread.subject, body);
      await deps.boards.replyToThread(ctx.threadId, state.handle ?? 'unknown', body, deps.now());
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
    await deps.boards.createThread(
      ctx.boardId,
      state.handle ?? 'unknown',
      ctx.composingSubject,
      body,
      deps.now(),
    );
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
      output: `${errorScreen(`Message is at the ${BODY_MAX}-character limit. End with . or ABORT.`)}\n${composeScreen('Message (end with .):', width)}`,
    };
  }
  const next: SessionState = {
    ...state,
    boardContext: { ...ctx, composingBody: candidate },
  };
  return { state: next, output: '' };
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
