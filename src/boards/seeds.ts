/**
 * src/boards/seeds.ts — Archive seed content (builder-written).
 *
 * Starter content for the four boards, dated 1994 and flagged isArchive.
 * Every archive post is labeled "ARCHIVE - 1994" wherever it is displayed
 * (R4.7, R10.1). These are lore, not fake user activity: no seed post ever
 * pretends to be a live user, and the seed only loads when no data file
 * exists yet.
 */

import type { BoardsData } from '../shared/validation.js';

export function seedBoardsData(): BoardsData {
  return {
    boards: [
      {
        id: 'general',
        name: 'General Discussion',
        description: 'The town square. Say hello, argue about modems.',
      },
      {
        id: 'tech',
        name: 'Tech Talk',
        description: 'Hardware, software, and things that beep.',
      },
      {
        id: 'games',
        name: 'Door Games',
        description: 'High scores, strategies, and CATACOMB legends.',
      },
      {
        id: 'crypt',
        name: 'The Crypt',
        description: 'Late-night confessions and ghost stories. Lights low.',
      },
    ],
    threads: [
      {
        id: 'seed-thread-1',
        boardId: 'general',
        subject: 'Welcome to DeadLine!',
        authorHandle: 'SYSOP',
        createdAt: '1994-03-12T19:02:00.000Z',
        posts: [
          {
            id: 'seed-post-1a',
            threadId: 'seed-thread-1',
            boardId: 'general',
            authorHandle: 'SYSOP',
            subject: 'Welcome to DeadLine!',
            body: 'You have reached DeadLine BBS, running on a 486DX2-66 with 8MB of RAM and a USRobotics Sportster 14.4. One node, one phone line, one caller at a time.\n\nBe kind, keep it clean, and log off when your time is up. The next caller is waiting, and the phone bill is real.',
            createdAt: '1994-03-12T19:02:00.000Z',
            isArchive: true,
          },
          {
            id: 'seed-post-1b',
            threadId: 'seed-thread-1',
            boardId: 'general',
            authorHandle: 'ModemMary',
            subject: 'Welcome to DeadLine!',
            body: 'First! Dialed in on my 2400 baud modem and it still feels like magic. The ANSI welcome screen alone was worth the busy signals.',
            createdAt: '1994-03-12T20:14:00.000Z',
            isArchive: true,
          },
        ],
      },
      {
        id: 'seed-thread-2',
        boardId: 'general',
        subject: 'Is a 14.4 modem worth it?',
        authorHandle: 'ModemMary',
        createdAt: '1994-05-02T21:40:00.000Z',
        posts: [
          {
            id: 'seed-post-2a',
            threadId: 'seed-thread-2',
            boardId: 'general',
            authorHandle: 'ModemMary',
            subject: 'Is a 14.4 modem worth it?',
            body: 'My 2400 baud has served me well, but downloading anything bigger than a text file takes forever. Is the jump to 14.4 really six times faster in practice, or is that just the box talking?',
            createdAt: '1994-05-02T21:40:00.000Z',
            isArchive: true,
          },
          {
            id: 'seed-post-2b',
            threadId: 'seed-thread-2',
            boardId: 'general',
            authorHandle: 'ByteRider',
            subject: 'Is a 14.4 modem worth it?',
            body: 'Do it. A 1MB file drops from about an hour to ten minutes. Your phone bill will thank you, and so will everyone else waiting for the line.',
            createdAt: '1994-05-03T18:22:00.000Z',
            isArchive: true,
          },
        ],
      },
      {
        id: 'seed-thread-3',
        boardId: 'tech',
        subject: 'ANSI art tutorial, part 1',
        authorHandle: 'Phantom-7',
        createdAt: '1994-04-18T22:05:00.000Z',
        posts: [
          {
            id: 'seed-post-3a',
            threadId: 'seed-thread-3',
            boardId: 'tech',
            authorHandle: 'Phantom-7',
            subject: 'ANSI art tutorial, part 1',
            body: 'Start with TheDraw or ACiDDraw. Learn the block characters first: full block, half blocks, shades. Sixteen colors is plenty if you respect the palette.\n\nRule one: every line is exactly 80 columns. Rule two: never trust a screen you have not seen on a real terminal.',
            createdAt: '1994-04-18T22:05:00.000Z',
            isArchive: true,
          },
          {
            id: 'seed-post-3b',
            threadId: 'seed-thread-3',
            boardId: 'tech',
            authorHandle: 'SYSOP',
            subject: 'ANSI art tutorial, part 1',
            body: 'Post your finished screens in the file area and the best one becomes next month welcome screen. No pressure.',
            createdAt: '1994-04-19T19:31:00.000Z',
            isArchive: true,
          },
        ],
      },
      {
        id: 'seed-thread-4',
        boardId: 'tech',
        subject: 'FidoNet echomail setup notes',
        authorHandle: 'ByteRider',
        createdAt: '1994-06-21T20:47:00.000Z',
        posts: [
          {
            id: 'seed-post-4a',
            threadId: 'seed-thread-4',
            boardId: 'tech',
            authorHandle: 'ByteRider',
            subject: 'FidoNet echomail setup notes',
            body: 'For anyone setting up a point: get the nodelist first, then your boss node address, then configure the mailer to poll at night when the rates drop. Echomail arrives in packets; the tosser sorts it into areas.\n\nIf your mailer and your BBS disagree about the time, fix the clock before you touch anything else.',
            createdAt: '1994-06-21T20:47:00.000Z',
            isArchive: true,
          },
        ],
      },
      {
        id: 'seed-thread-5',
        boardId: 'games',
        subject: 'LORD high scores — June',
        authorHandle: 'NightOwl',
        createdAt: '1994-06-30T23:58:00.000Z',
        posts: [
          {
            id: 'seed-post-5a',
            threadId: 'seed-thread-5',
            boardId: 'games',
            authorHandle: 'NightOwl',
            subject: 'LORD high scores — June',
            body: 'Final standings for June. Red Dragon slain twice, both times by VioletStorm. The rest of us are still grinding the forest.\n\nNew season starts July 1. Same rules: no sharing accounts, no begging the sysop for extra turns.',
            createdAt: '1994-06-30T23:58:00.000Z',
            isArchive: true,
          },
        ],
      },
      {
        id: 'seed-thread-6',
        boardId: 'games',
        subject: 'CATACOMB strategy thread',
        authorHandle: 'SYSOP',
        createdAt: '1994-07-09T21:15:00.000Z',
        posts: [
          {
            id: 'seed-post-6a',
            threadId: 'seed-thread-6',
            boardId: 'games',
            authorHandle: 'SYSOP',
            subject: 'CATACOMB strategy thread',
            body: 'The Crypt Lord waits at depth 5. Practical advice: rest before you descend, never explore on your last turn of the day, and remember that running away is free.\n\nThe Hall of Fame only records victories. Deaths are forgotten by morning.',
            createdAt: '1994-07-09T21:15:00.000Z',
            isArchive: true,
          },
          {
            id: 'seed-post-6b',
            threadId: 'seed-thread-6',
            boardId: 'games',
            authorHandle: 'NightOwl',
            subject: 'CATACOMB strategy thread',
            body: 'Died at depth 4 three nights running. The Lich is no joke. Tonight I rest at full health first and bring every gold piece I own.',
            createdAt: '1994-07-10T00:03:00.000Z',
            isArchive: true,
          },
        ],
      },
      {
        id: 'seed-thread-7',
        boardId: 'crypt',
        subject: 'The modem that called itself',
        authorHandle: 'Phantom-7',
        createdAt: '1994-10-31T23:59:00.000Z',
        posts: [
          {
            id: 'seed-post-7a',
            threadId: 'seed-thread-7',
            boardId: 'crypt',
            authorHandle: 'Phantom-7',
            subject: 'The modem that called itself',
            body: 'True story, or so I am told. A sysop in Ohio left his BBS running overnight. At 3 AM the log showed a caller connect, read one message, and disconnect. The caller ID was his own number.\n\nHe checked the phone line. It had been unplugged for a week.',
            createdAt: '1994-10-31T23:59:00.000Z',
            isArchive: true,
          },
        ],
      },
      {
        id: 'seed-thread-8',
        boardId: 'crypt',
        subject: '3 AM sysop confessions',
        authorHandle: 'NightOwl',
        createdAt: '1994-11-15T03:12:00.000Z',
        posts: [
          {
            id: 'seed-post-8a',
            threadId: 'seed-thread-8',
            boardId: 'crypt',
            authorHandle: 'NightOwl',
            subject: '3 AM sysop confessions',
            body: 'People keep talking about this World Wide Web thing like the BBS days are numbered. Maybe. But no web page ever waited for you on a busy signal, and no browser ever felt like a place.\n\nWhatever comes next, this board stays up as long as the phone line holds.',
            createdAt: '1994-11-15T03:12:00.000Z',
            isArchive: true,
          },
        ],
      },
    ],
  };
}
