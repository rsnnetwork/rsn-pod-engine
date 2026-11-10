// ─── The organiser matching board, on the preview (10 Nov 2026 spec, Part 2 Task 13; spec 06, 07, 12/06-10) ───
//
// What the board's screen promises, read from its source and, where a file can run on its own, run:
//   - a drop is one board op: onto an occupied seat a swap, onto an empty seat a move, into the basket an unassign,
//     into another round nothing ("Drop it in the same round.");
//   - the board's read is kept live by its three tags, and the cache is written by hand only with a board the server
//     returned (a write's answer, or the board sent back with SCHEDULE_CHANGED);
//   - MoveSheet, the phone's and the keyboard's way, offers swap, move, basket, lock and the person's meetings, each
//     row 44px or more, each target with the shared checker's instant hint;
//   - the all-rounds table is the only thing that scrolls sideways, inside its own frame;
//   - the words the spec draws: "ROUND 02 / MATCHING BOARD", "Room 01", "UNASSIGNED BASKET", "{n} people waiting", the
//     basket's hint, "Redistribute", "Auto generate | Edit | Lock | Publish";
//   - the live host sees "Locked" on a locked meeting, and the locked-meeting sentence when a swap touches it.

import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardPerson, BoardRoom, BoardRound, BoardSeat, EventGroupRules, RoomVerdict, ScheduleBoard } from '@rsn/shared';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';
import { DROP_SAME_ROUND, decodeDrag, dropIntent, dropRefusal, encodeDrag } from '../../../../client/src/features/schedule/board-dnd';
import {
  BOARD_COPY, MOVE_COPY, NO_FILTER, conflictsOf, moveHint, overviewRows, personMatches, roomMatches, roomTitle, roundTitle,
  rowMatches, swapHint, timelineLine, timelineOf, waitingLine,
} from '../../../../client/src/features/schedule/board-model';
import { E as clientE } from '../../../../client/src/realtime/entities';

const SCHEDULE_DIR = 'features/schedule';
const CLIENT = path.join(__dirname, '../../../../client/src');
/** A client file, comments stripped, so a word in a comment is never read as code. */
const code = (rel: string) => readClientSource(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const scheduleFiles = () => fs.readdirSync(path.join(CLIENT, SCHEDULE_DIR)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${SCHEDULE_DIR}/${f}`);

// ─── A small board: founders and funders, cross-group in both rounds ─────────

const RULES: EventGroupRules = {
  groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
  question: 'Are you a founder or a funder?', allowMultiple: false, fallback: 'leave_unmatched',
  rounds: [{ fromRound: 1, toRound: 2, mode: 'cross_group', allowedPairs: [] }],
};
const ok = (over: Partial<RoomVerdict> = {}): RoomVerdict => ({ ok: true, problems: [], warnings: [], ...over });
const person = (userId: string, displayName: string, group: string, status: BoardPerson['status'] = 'registered'): BoardPerson =>
  ({ userId, displayName, avatarUrl: null, groupKeys: [group], status });
const ann = person('ann', 'Ann', 'founder');
const bob = person('bob', 'Bob', 'funder');
const cat = person('cat', 'Cat', 'founder');
const dan = person('dan', 'Dan', 'funder');
const eve = person('eve', 'Eve', 'founder');
const fay = person('fay', 'Fay', 'funder');
const seat = (p: BoardPerson, extra: Partial<BoardSeat> = {}): BoardSeat => ({ ...p, slotLocked: false, source: 'auto', override: false, ...extra });
const room = (roomNumber: number, people: BoardPerson[], extra: Partial<BoardRoom> = {}): BoardRoom =>
  ({ roomNumber, seats: people.map((p) => seat(p)), locked: false, verdict: ok(), ...extra });
const round = (roundNumber: number, rooms: BoardRoom[], basket: BoardPerson[], extra: Partial<BoardRound> = {}): BoardRound =>
  ({ roundNumber, startsAt: null, editable: true, rooms, basket, capacity: null, collisions: [], ...extra });

function makeBoard(): ScheduleBoard {
  return {
    sessionId: 's-1', revision: 4, publishedVersion: null, draftDiffersFromPublished: true, groupRules: RULES, canOverride: true,
    people: [ann, bob, cat, dan, eve, fay],
    rounds: [
      round(1, [
        room(1, [ann, bob]),
        room(2, [cat, dan], { locked: true }),
        room(3, [eve], { verdict: ok({ warnings: [{ kind: 'vacancy', userIds: ['eve'] }] }) }),
      ], [fay]),
      round(2, [
        room(1, [ann, dan]),
        room(2, [cat, bob], { verdict: { ok: false, problems: [{ kind: 'group_rule', userIds: ['cat', 'bob'] }], warnings: [] } }),
        room(3, [fay], { locked: true, verdict: ok({ warnings: [{ kind: 'vacancy', userIds: ['fay'] }] }) }),
      ], [eve], {
        capacity: { round: 2, maxMeetings: 3, waiting: { founder: 1 }, repeatsUnavoidableFor: [], ungrouped: 0, sentence: 'In each round at most 3 founder and funder meetings are possible, so 1 founder waits.' },
      }),
    ],
  };
}

// ─── Dropping ────────────────────────────────────────────────────────────────

describe('a drop is one board op (spec 06 core interactions, 12/07 and 12/08)', () => {
  const from = { round: 2, userId: 'ann', fromRoom: 1 };

  it('onto an occupied seat swaps the two, neither dropped', () => {
    expect(dropIntent(from, { kind: 'seat', round: 2, room: 2, occupantId: 'bob' })).toEqual({ kind: 'swap', round: 2, userId: 'ann', withUserId: 'bob' });
  });
  it('onto an empty seat moves them, their old seat emptying', () => {
    expect(dropIntent(from, { kind: 'seat', round: 2, room: 4, occupantId: null })).toEqual({ kind: 'move', round: 2, userId: 'ann', toRoom: 4 });
  });
  it('into the basket unassigns them for the round', () => {
    expect(dropIntent(from, { kind: 'basket', round: 2 })).toEqual({ kind: 'unassign', round: 2, userId: 'ann' });
  });
  it('into another round asks for nothing, and says why', () => {
    const target = { kind: 'seat', round: 3, room: 1, occupantId: 'bob' } as const;
    expect(dropIntent(from, target)).toBeNull();
    expect(dropIntent(from, { kind: 'basket', round: 1 })).toBeNull();
    expect(dropRefusal(from, target)).toBe('Drop it in the same round.');
    expect(DROP_SAME_ROUND).toBe('Drop it in the same round.');
  });
  it('where they already are asks for nothing: their own seat, their own room, the basket from the basket', () => {
    expect(dropIntent(from, { kind: 'seat', round: 2, room: 1, occupantId: 'ann' })).toBeNull();
    expect(dropIntent(from, { kind: 'seat', round: 2, room: 1, occupantId: 'dan' })).toBeNull();
    expect(dropIntent(from, { kind: 'seat', round: 2, room: 1, occupantId: null })).toBeNull();
    expect(dropIntent({ round: 2, userId: 'eve', fromRoom: null }, { kind: 'basket', round: 2 })).toBeNull();
    expect(dropRefusal(from, { kind: 'basket', round: 2 })).toBeNull();
  });
  it('someone from the basket dropped on a seat swaps in (the seated person goes to the basket)', () => {
    expect(dropIntent({ round: 2, userId: 'eve', fromRoom: null }, { kind: 'seat', round: 2, room: 1, occupantId: 'ann' }))
      .toEqual({ kind: 'swap', round: 2, userId: 'eve', withUserId: 'ann' });
  });
  it('carries its own data type, and reads nothing else as a person', () => {
    expect(decodeDrag(encodeDrag(from))).toEqual(from);
    expect(decodeDrag('https://example.com')).toBeNull();
    expect(decodeDrag('{"round":"2"}')).toBeNull();
    expect(code(`${SCHEDULE_DIR}/SeatChip.tsx`)).toMatch(/e\.dataTransfer\.setData\(BOARD_DRAG_TYPE, encodeDrag\(source\)\)/);
  });
  it('is native drag and drop: the client has no drag library', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => /dnd|drag|sortable/i.test(d))).toEqual([]);
    expect(code(`${SCHEDULE_DIR}/SeatChip.tsx`)).toMatch(/draggable=\{draggable\}/);
    // A touch screen selects and moves instead: dragging is offered to a fine pointer only.
    expect(code(`${SCHEDULE_DIR}/MatchingBoardPage.tsx`)).toContain("const query = '(pointer: fine)';");
    expect(code(`${SCHEDULE_DIR}/MatchingBoardPage.tsx`)).toMatch(/draggable=\{fine\}/);
  });
});

// ─── The data ────────────────────────────────────────────────────────────────

describe('useBoard: one live read, and the server\'s board as the only hand-written cache entry', () => {
  const hook = code(`${SCHEDULE_DIR}/useBoard.ts`);

  it('the read declares the draft, the groups and the people as its tags', () => {
    expect(hook).toContain('meta: { entities: [E.sessionSchedule(sessionId), E.sessionGroups(sessionId), E.sessionParticipants(sessionId)] }');
    expect(clientE.sessionSchedule('s-1')).toBe('session:s-1:schedule');
    expect(clientE.sessionGroups('s-1')).toBe('session:s-1:groups');
    expect(clientE.sessionParticipants('s-1')).toBe('session:s-1:participants');
    expect(hook).toContain("api.get(`/sessions/${sessionId}/schedule`)");
  });

  it('no setQueryData anywhere on the board but applyReturnedBoard, which writes the board the server answered', () => {
    const uses = scheduleFiles().flatMap((f) => (code(f).match(/setQueryData/g) ?? []).map(() => f));
    expect(uses).toEqual([`${SCHEDULE_DIR}/useBoard.ts`]);
    expect(hook).toMatch(/const applyReturnedBoard = useCallback\(\(board: ScheduleBoard\) => \{\s*void qc\.cancelQueries\(\{ queryKey: boardQueryKey\(sessionId\) \}\);\s*qc\.setQueryData\(boardQueryKey\(sessionId\), board\);\s*\}/);
    expect(hook).toContain('onSuccess: (result) => applyReturnedBoard(result.board),');
  });

  it('every write names the revision of the board on screen, on the routes Task 8 serves', () => {
    expect(hook).toContain("api.post(`/sessions/${sessionId}/schedule/generate`, { expectedRevision, rounds: write.rounds })");
    expect(hook).toContain("api.post(`/sessions/${sessionId}/schedule/ops`, { expectedRevision, op: write.op })");
    expect(hook).toMatch(/const current = qc\.getQueryData<ScheduleBoard>\(boardQueryKey\(sessionId\)\);\s*return sendWrite\(sessionId, current\?\.revision \?\? 0, write\);/);
  });

  it('a stale write shows the board the server sent back, with the server\'s sentence', () => {
    expect(hook).toMatch(/if \(error\.code === ErrorCodes\.SCHEDULE_CHANGED && error\.board\) \{\s*applyReturnedBoard\(error\.board\);\s*addToast\(error\.message, 'error'\);/);
  });

  it('a read that left before a write answered never puts the older board back', () => {
    const { keepNewestBoard } = loadClientModule(`${SCHEDULE_DIR}/useBoard.ts`, {
      '@/lib/api': { __esModule: true, default: {} },
      '@/stores/toastStore': { useToastStore: () => undefined },
    }) as { keepNewestBoard: (a: unknown, b: unknown) => unknown };
    const newer = { ...makeBoard(), revision: 7 };
    const older = { ...makeBoard(), revision: 6 };
    expect(keepNewestBoard(newer, older)).toBe(newer);
    expect(keepNewestBoard(older, newer)).toBe(newer);
    const sameRevision = { ...makeBoard(), revision: 7 };
    expect(keepNewestBoard(newer, sameRevision)).toBe(sameRevision);
    expect(keepNewestBoard(undefined, older)).toBe(older);
    expect(hook).toContain('structuralSharing: keepNewestBoard,');
  });

  it('a refused move keeps its alternatives for the screen; only the owner or a super admin is offered the override', () => {
    expect(hook).toMatch(/overridable: error\.code === ErrorCodes\.SCHEDULE_GROUP_RULE && canOverride && write\.op\.override !== true/);
    const refusal = code(`${SCHEDULE_DIR}/RefusalSheet.tsx`);
    expect(refusal).toContain('{refusal.overridable && (');
    expect(refusal).toContain("onChoose({ ...op, override: true, ...(reason.trim() ? { reason: reason.trim() } : {}) })");
  });
});

describe('what a refused write says (board-errors)', () => {
  const { boardErrorOf } = loadClientModule(`${SCHEDULE_DIR}/board-errors.ts`, {}) as {
    boardErrorOf: (err: unknown) => { status: number | null; code: string; message: string; board: unknown; alternatives: unknown };
  };
  const failed = (status: number, error: Record<string, unknown>) => ({ response: { status, data: { error } } });

  it('SCHEDULE_CHANGED: the server\'s sentence and the board now', () => {
    const board = makeBoard();
    const e = boardErrorOf(failed(409, {
      code: 'SCHEDULE_CHANGED', message: 'The board changed while you were editing. It is up to date now; try again.', details: { board },
    }));
    expect(e).toMatchObject({ status: 409, code: 'SCHEDULE_CHANGED', message: 'The board changed while you were editing. It is up to date now; try again.' });
    expect(e.board).toBe(board);
  });
  it('a refused move: the reason and the alternatives', () => {
    const alternatives = [{ room: 3, note: 'Room 3, with Eve' }, { room: 0, note: 'Leave them in the basket' }];
    const e = boardErrorOf(failed(409, { code: 'SCHEDULE_GROUP_RULE', message: "Ann and Cat can't meet in this round: everyone meets someone from another group.", details: { alternatives } }));
    expect(e.alternatives).toEqual(alternatives);
    expect(e.board).toBeNull();
  });
  it('never shows a raw id, and says a lost connection plainly', () => {
    expect(boardErrorOf(failed(404, { message: 'Session with id 5e550000-0000-4000-8000-00000000dead not found' })).message).toBe("We couldn't find that event.");
    expect(boardErrorOf(failed(429, {})).message).toBe('Slow down a moment, then try again.');
    expect(boardErrorOf({ isAxiosError: true, code: 'ERR_NETWORK' }).message).toBe('Connection lost. Check your internet and try again.');
  });
});

// ─── The checker's instant hint, conflicts, filters, the table, one person ──

describe('the board read for the screen (board-model)', () => {
  const board = makeBoard();

  it('the spec\'s words', () => {
    expect(roundTitle(2)).toBe('ROUND 02 / MATCHING BOARD');
    expect(roundTitle(12)).toBe('ROUND 12 / MATCHING BOARD');
    expect(roomTitle(1)).toBe('Room 01');
    expect(BOARD_COPY.basketTitle).toBe('UNASSIGNED BASKET');
    expect(BOARD_COPY.basketHint).toBe('Drag people here, swap occupied slots, then redistribute available participants.');
    expect(BOARD_COPY.redistribute).toBe('Redistribute');
    expect([BOARD_COPY.autoGenerate, BOARD_COPY.edit, BOARD_COPY.lock, BOARD_COPY.publish]).toEqual(['Auto generate', 'Edit', 'Lock', 'Publish']);
    expect([waitingLine(0), waitingLine(1), waitingLine(4)]).toEqual(['0 people waiting', '1 person waiting', '4 people waiting']);
    expect(MOVE_COPY.swapWith('Bob')).toBe('Swap with Bob');
    expect(MOVE_COPY.moveTo(3)).toBe('Move to room 3 (empty seat)');
    expect(MOVE_COPY.toBasket).toBe('Move to the basket');
    expect(MOVE_COPY.lockMeeting).toBe('Lock this meeting');
    expect(MOVE_COPY.showMeetings('Ann')).toBe("Show Ann's meetings");
  });

  it('the hint is the shared room checker: a funder joining a lone founder fits, a second funder breaks the rule', () => {
    expect(moveHint(board, 1, 'fay', 3)).toEqual({ tone: 'ok', text: 'Fits this round' });
    expect(moveHint(board, 1, 'fay', 1)).toEqual({ tone: 'bad', text: "Breaks this round's group rule" });
    expect(moveHint(board, 1, 'fay', 4)).toEqual({ tone: 'warn', text: 'Waits alone until someone joins' });
  });

  it('a swap is judged by the worse of the two rooms it makes, earlier meetings counted as repeats', () => {
    expect(swapHint(board, 2, 'dan', 'bob')).toEqual({ tone: 'warn', text: 'They have met before' });
    expect(swapHint(board, 1, 'ann', 'dan')).toEqual({ tone: 'bad', text: "Breaks this round's group rule" });
    // A person from the basket takes the seat; the seated person waits, so only one room is judged.
    expect(swapHint(board, 1, 'fay', 'bob')).toEqual({ tone: 'ok', text: 'Fits this round' });
  });

  it('conflicts: problems first, the reason in the organiser\'s words, a locked meeting that lost someone, the capacity sentence', () => {
    const all = conflictsOf(board);
    expect(all[0]).toEqual({ round: 2, room: 2, tone: 'problem', text: "Cat and Bob can't meet in this round: everyone meets someone from another group." });
    expect(all.map((c) => c.text)).toEqual(expect.arrayContaining([
      'Room 03 is locked and has an empty seat. Nobody is moved into a locked meeting.',
      'In each round at most 3 founder and funder meetings are possible, so 1 founder waits.',
    ]));
    expect(conflictsOf(board, 1)).toEqual([]);
  });

  it('search and filters: by name, group, status, conflicts only, locked only', () => {
    const r2 = board.rounds[1];
    expect(r2.rooms.filter((x) => roomMatches(x, { ...NO_FILTER, query: 'ca' })).map((x) => x.roomNumber)).toEqual([2]);
    expect(r2.rooms.filter((x) => roomMatches(x, { ...NO_FILTER, conflictsOnly: true })).map((x) => x.roomNumber)).toEqual([2, 3]);
    expect(r2.rooms.filter((x) => roomMatches(x, { ...NO_FILTER, lockedOnly: true })).map((x) => x.roomNumber)).toEqual([3]);
    expect(personMatches(eve, { ...NO_FILTER, status: 'waiting' }, true)).toBe(true);
    expect(personMatches(eve, { ...NO_FILTER, group: 'funder' }, true)).toBe(false);
  });

  it('the all-rounds rows: one per seat and per person waiting, with room, group, status, lock and conflicts', () => {
    const rows = overviewRows(board);
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.round === 2 && r.userId === 'cat')).toMatchObject({ room: 2, groups: ['Founders'], conflicts: ['Group rule'] });
    expect(rows.find((r) => r.round === 1 && r.userId === 'fay')).toMatchObject({ room: null, conflicts: [] });
    expect(rows.find((r) => r.round === 2 && r.userId === 'fay')).toMatchObject({ roomLocked: true, conflicts: ['Locked, empty seat'] });
    expect(rows.filter((r) => rowMatches(r, undefined, { ...NO_FILTER, lockedOnly: true })).map((r) => r.key))
      .toEqual(['1:2:cat', '1:2:dan', '2:3:fay']);
  });

  it('one person across the rounds (spec 07: review all assignments for that attendee)', () => {
    expect(timelineOf(board, 'eve').map(timelineLine)).toEqual(['Room 03, alone so far', 'Waiting in the basket']);
    expect(timelineOf(board, 'ann').map(timelineLine)).toEqual(['Room 01, with Bob (Funders)', 'Room 01, with Dan (Funders)']);
    expect(timelineOf(board, 'cat').map(timelineLine)[0]).toBe('Room 02, with Dan (Funders) (locked)');
  });
});

// ─── The screens ─────────────────────────────────────────────────────────────

const sheetStandIn = { __esModule: true, default: ({ title, children }: { title: string; children?: unknown }) => createElement('div', { 'data-sheet': title }, children as never) };
const buttonClasses = (html: string) => Array.from(html.matchAll(/<button[^>]*class="([^"]*)"/g), (m) => m[1]);
const tallEnough = (cls: string) => /min-h-\[(4[4-9]|[5-9]\d)px\]/.test(cls);

describe('MoveSheet: select and move, for the phone and the keyboard', () => {
  const MoveSheet = loadClientModule(`${SCHEDULE_DIR}/MoveSheet.tsx`, {
    'lucide-react': iconStandIns,
    '@/features/reason/ui/Sheet': sheetStandIn,
  }).default as (props: Record<string, unknown>) => JSX.Element;
  const board = makeBoard();
  const draw = (who: BoardPerson, roundIndex = 0, canEdit = true) => renderToStaticMarkup(createElement(MoveSheet, {
    board, round: board.rounds[roundIndex], person: who, canEdit, onRun: () => undefined, onShowMeetings: () => undefined, onClose: () => undefined,
  }));

  it('offers swap, move to a room with a free seat, the basket, lock and the person\'s meetings, every row 44px or more', () => {
    const html = draw(ann);
    expect(html).toContain('data-sheet="Ann, round 1"');
    for (const words of ['Swap with Eve', 'Move to room 3 (empty seat)', 'Move to room 4 (empty seat)', 'Move to the basket', 'Lock this meeting', 'Keep Ann in this seat', "Show Ann&#x27;s meetings"]) {
      expect(html).toContain(words);
    }
    const classes = buttonClasses(html);
    expect(classes.length).toBeGreaterThanOrEqual(7);
    expect(classes.filter((c) => !tallEnough(c))).toEqual([]);
  });

  it('each target carries the checker\'s instant hint', () => {
    const html = draw(fay);
    expect(html).toContain('Swap with Ann');
    expect(html).toContain("Breaks this round&#x27;s group rule");
    expect(html).toContain('Fits this round');
    // Nobody in a locked meeting is offered, and someone waiting cannot be moved to the basket.
    expect(html).not.toContain('Swap with Cat');
    expect(html).not.toContain('Move to the basket');
  });

  it('a locked meeting says so and offers only its unlock and the meetings', () => {
    const html = draw(cat);
    expect(html).toContain('This meeting is locked. Unlock it first to move Cat.');
    expect(html).toContain('Unlock this meeting');
    expect(html).not.toContain('Swap with');
    expect(html).not.toContain('Move to room');
  });

  it('a round that has started can only be read', () => {
    const html = draw(ann, 0, false);
    expect(html).toContain("This round can&#x27;t change now.");
    expect(html).not.toContain('Swap with');
    expect(html).toContain("Show Ann&#x27;s meetings");
  });

  it('uses buttons with words, never the deprecated drag attributes; the arrow keys walk the seats', () => {
    for (const f of scheduleFiles()) expect({ f, grabbed: /aria-(grabbed|dropeffect)/.test(code(f)) }).toEqual({ f, grabbed: false });
    const view = code(`${SCHEDULE_DIR}/RoundView.tsx`);
    expect(view).toContain("e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0");
    expect(view).toContain("querySelectorAll<HTMLElement>('[data-seat]')");
    expect(code(`${SCHEDULE_DIR}/SeatChip.tsx`)).toMatch(/<button\s+type="button"\s+data-seat/);
  });
});

describe('the toolbar, the basket and the headings', () => {
  it('"Auto generate | Edit | Lock | Publish", each 44px', () => {
    const Toolbar = loadClientModule(`${SCHEDULE_DIR}/BoardToolbar.tsx`, { 'lucide-react': iconStandIns }).default as (p: Record<string, unknown>) => JSX.Element;
    const html = renderToStaticMarkup(createElement(Toolbar, {
      canGenerate: true, editing: true, lockAction: 'lock', busy: false,
      onGenerate: () => undefined, onToggleEdit: () => undefined, onToggleLock: () => undefined, onPublish: () => undefined,
    }));
    expect(Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g), (m) => m[1])).toEqual(['Auto generate', 'Edit', 'Lock', 'Publish']);
    expect(buttonClasses(html).filter((c) => !tallEnough(c))).toEqual([]);
  });

  it('the basket: its title, the count, the hint and Redistribute', () => {
    const Basket = loadClientModule(`${SCHEDULE_DIR}/BasketTray.tsx`, { 'lucide-react': iconStandIns }).default as (p: Record<string, unknown>) => JSX.Element;
    const board = makeBoard();
    const html = renderToStaticMarkup(createElement(Basket, {
      board, round: 1, basket: board.rounds[0].basket, canEdit: true, draggable: true, filter: NO_FILTER, selectedId: null, dragging: null,
      busy: false, onSelect: () => undefined, onDragStart: () => undefined, onDragEnd: () => undefined, onDrop: () => undefined, onRedistribute: () => undefined,
    }));
    expect(html).toContain('UNASSIGNED BASKET');
    expect(html).toContain('1 person waiting');
    expect(html).toContain('Drag people here, swap occupied slots, then redistribute available participants.');
    expect(html).toContain('Redistribute');
    expect(html).toContain('Funders: </span><span class="font-medium">Fay</span>');
    expect(buttonClasses(html).filter((c) => !tallEnough(c))).toEqual([]);
  });

  it('a room card: "Room 01", its lock, its verdict badges, its people with their group', () => {
    const Card = loadClientModule(`${SCHEDULE_DIR}/BoardRoomCard.tsx`, { 'lucide-react': iconStandIns }).default as (p: Record<string, unknown>) => JSX.Element;
    const board = makeBoard();
    const html = renderToStaticMarkup(createElement(Card, {
      board, round: 2, room: board.rounds[1].rooms[1], canEdit: true, draggable: true, filter: NO_FILTER, selectedId: null, dragging: null,
      dropHint: null, busy: false, onSelect: () => undefined, onDragStart: () => undefined, onDragEnd: () => undefined, onDrop: () => undefined,
      onToggleLock: () => undefined,
    }));
    expect(html).toContain('Room 02');
    expect(html).toContain('aria-label="Lock Room 02"');
    expect(html).toContain('Group rule');
    expect(html).toContain('Founders: </span><span class="font-medium">Cat</span>');
    expect(buttonClasses(html).filter((c) => !tallEnough(c))).toEqual([]);
  });

  it('the round view\'s heading and time, the all-rounds heading', () => {
    const page = code(`${SCHEDULE_DIR}/MatchingBoardPage.tsx`);
    expect(page).toContain("{view === 'round' ? roundTitle(r) : BOARD_COPY.allRoundsTitle}");
    expect(page).toContain('Starts about {time}');
    expect(BOARD_COPY.allRoundsTitle).toBe('ALL ROUNDS / MATCHING BOARD');
  });

  it('the capacity sentence above the round, with the fallback the organiser chose and a way to change it', () => {
    const view = code(`${SCHEDULE_DIR}/RoundView.tsx`);
    expect(view).toContain('const capacity = round.capacity?.sentence ?? null;');
    expect(view).toContain('{FALLBACK_LINE[board.groupRules.fallback]}');
    expect(view).toContain('to={`/sessions/${sessionId}#groups`}');
  });
});

describe('the all-rounds overview scrolls sideways inside its own frame, and nothing else does', () => {
  it('overflow-x-auto is on the table\'s frame, once, and on nothing else of the board', () => {
    const hits = scheduleFiles().flatMap((f) => (code(f).match(/overflow-x-(auto|scroll)|\boverflow-(auto|scroll)\b/g) ?? []).map((m) => `${f}:${m}`));
    expect(hits).toEqual([`${SCHEDULE_DIR}/AllRoundsOverview.tsx:overflow-x-auto`]);
  });

  it('the frame holds the wide table, as wide as the page allows and no wider', () => {
    const Overview = loadClientModule(`${SCHEDULE_DIR}/AllRoundsOverview.tsx`, { 'lucide-react': iconStandIns }).default as (p: Record<string, unknown>) => JSX.Element;
    const html = renderToStaticMarkup(createElement(Overview, { board: makeBoard(), filter: NO_FILTER, onOpenPerson: () => undefined, onOpenRound: () => undefined }));
    expect(html).toMatch(/<div data-testid="board-overview-scroll" class="max-w-full overflow-x-auto [^"]*"><table class="w-full min-w-\[760px\]/);
    expect(html.match(/data-testid="board-overview-row"/g)).toHaveLength(12);
    for (const head of ['Time', 'Round', 'Room', 'Group', 'Participant', 'Status', 'Lock', 'Conflicts']) expect(html).toContain(`>${head}</th>`);
  });

  it('no fixed width on the board is wider than a 360px phone', () => {
    const wide = scheduleFiles().flatMap((f) => Array.from(code(f).matchAll(/(?<![-\w])w-\[(\d+)px\]/g), (m) => Number(m[1]))
      .filter((px) => px > 360).map((px) => `${f}: w-[${px}px]`));
    expect(wide).toEqual([]);
    expect(code(`${SCHEDULE_DIR}/MatchingBoardPage.tsx`)).toContain('mx-auto flex w-full min-w-0 max-w-[1200px] flex-col gap-4');
  });
});

describe('every read of the board\'s screens is live', () => {
  it('the publish preview follows the draft; the versions list follows the published schedule too', () => {
    const publish = code(`${SCHEDULE_DIR}/publish-api.ts`);
    expect(publish).toContain('meta: { entities: [E.sessionSchedule(sessionId), E.sessionGroups(sessionId), E.sessionParticipants(sessionId)] }');
    expect(publish).toContain('meta: { entities: [E.sessionSchedule(sessionId), publishedScheduleTag(sessionId)] }');
    expect(code(`${SCHEDULE_DIR}/MatchingBoardPage.tsx`)).toContain('meta: { entities: [E.session(sessionId)] }');
  });
});

describe('Publish: the preview, "Publish version {n}", the versions (Task 9\'s routes, in one module)', () => {
  const mod = loadClientModule(`${SCHEDULE_DIR}/publish-api.ts`, {
    '@/lib/api': { __esModule: true, default: {} },
    '@/stores/toastStore': { useToastStore: () => undefined },
  }) as {
    publishCopy: { publishVersion: (n: number) => string; published: (n: number) => string; impacted: (n: number) => string };
    readVersion: (raw: Record<string, unknown>) => unknown;
    publishedScheduleTag: (id: string) => string;
  };

  it('follows the route shapes of the plan', () => {
    const publish = code(`${SCHEDULE_DIR}/publish-api.ts`);
    expect(publish).toContain("api.get(`/sessions/${sessionId}/schedule/publish-preview`)");
    expect(publish).toContain("api.post(`/sessions/${sessionId}/schedule/publish`, { expectedRevision: board?.revision ?? 0, ...(note ? { note } : {}) })");
    expect(publish).toContain("api.get(`/sessions/${sessionId}/schedule/versions`)");
    expect(mod.publishedScheduleTag('s-1')).toBe('session:s-1:published-schedule');
  });

  it('says "Publish version {n}", then "Version {n} published", and how many are told', () => {
    expect(mod.publishCopy.publishVersion(2)).toBe('Publish version 2');
    expect(mod.publishCopy.published(2)).toBe('Version 2 published');
    expect(mod.publishCopy.impacted(1)).toBe('1 person is told their meetings changed.');
    const panel = code(`${SCHEDULE_DIR}/PublishPanel.tsx`);
    // Blocking first, then warnings; the button waits while anything blocks.
    expect(panel.indexOf('data.blocking.length > 0 && (')).toBeLessThan(panel.indexOf('data.warnings.length > 0 && ('));
    expect(panel).toContain('disabled={blocked || publish.isPending}');
  });

  it('a version row never shows a raw code', () => {
    expect(mod.readVersion({ version: 3, automatic: true, reason: 'late_joiner', impactedUserIds: ['a', 'b'] }))
      .toMatchObject({ version: 3, automatic: true, reason: 'Someone arrived late', impactedCount: 2 });
    expect(mod.readVersion({ version: 4, reason: 'some_new_code' })).toMatchObject({ reason: null });
    expect(mod.readVersion({ nope: 1 })).toBeNull();
  });
});

describe('the way in, and the live host', () => {
  it('a protected route at /sessions/:sessionId/board', () => {
    expect(code('App.tsx')).toContain('<Route path="/sessions/:sessionId/board" element={<MatchingBoardPage />} />');
  });

  it('the event page links "Matching board" for the people who run a rounds event, before and during it', () => {
    const page = code('features/sessions/SessionDetailPage.tsx');
    expect(page).toMatch(/const mayPlanMeetings = isRoundsEvent && \(phase === 'pre' \|\| phase === 'live'\)\s*&& \(isHost \|\| viewerIsCohost \|\| user\?\.role === 'super_admin' \|\| pod\?\.memberRole === 'director'\);/);
    expect(page).toMatch(/to=\{`\/sessions\/\$\{sessionId\}\/board`\}\s*data-testid="matching-board-link"\s*className="min-h-\[44px\]/);
  });

  it('the live host sees "Locked" on a locked meeting, and the sentence when a swap or exclude touches it', () => {
    const locked = code(`${SCHEDULE_DIR}/locked-meeting.ts`);
    expect(locked).toContain("export const LOCKED_MEETING = 'This meeting is locked on the matching board.';");
    expect(locked).toContain("export const LOCKED_LABEL = 'Locked';");
    const controls = code('features/live/HostControls.tsx');
    expect(controls).toMatch(/\{m\.locked && \(\s*<span data-testid="preview-locked"/);
    expect(controls).toMatch(/const handleParticipantClick = \(userId: string\) => \{\s*if \(refuseLocked\(userId\)\) return;/);
    expect(controls).toMatch(/const excludeParticipant = \(userId: string\) => \{\s*if \(refuseLocked\(userId\)\) return;/);
    expect(code('features/live/HostRoundDashboard.tsx')).toMatch(/\{room\.locked && \(\s*<span data-testid="room-locked"/);
    const socket = code('hooks/useSessionSocket.ts');
    expect(socket).toContain("const LOCKED_ERRORS = Object.fromEntries(LOCKED_CODES.map((c) => [c, { msg: LOCKED_MEETING, severity: 'error' as const }]));");
    expect(socket).toMatch(/DM_REACT_FAILED: \{[^\n]*\},\s*\.\.\.LOCKED_ERRORS,\s*\};/);
    expect(locked).toContain("export const LOCKED_CODES: readonly string[] = ['SCHEDULE_LOCKED', 'MATCH_LOCKED'];");
    expect(code('stores/sessionStore.ts')).toContain('timesMet?: number; locked?: boolean }[];');
  });
});
