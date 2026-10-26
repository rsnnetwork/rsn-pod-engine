// server/src/__tests__/client/scheduler-flow.test.ts
// The scheduler's rules, EXECUTED (26 Oct 2026, after the 25 Oct walkthrough on production). scheduler-flow.ts is pure
// (no React, axios, store or router), so this imports it and runs it: the half hours of a day in a given time zone,
// across both of 2026's clock changes, what a Save says it did, and the words on screen. The second half reads the
// screens' source, like the other files in this folder, for the wiring the walkthrough tripped over: the green time
// that removed your own pick, the thread card's time that threw its slot away, and a typed time or unsaved pick lost
// without a word.
//
// On 25 Oct 2026 the clocks in Europe went back an hour, the same day Stefan and Claus both picked 13:00.

import * as fs from 'fs';
import * as path from 'path';
import {
  ASK_SEND, NOT_SHARED, SAVE_OVERLAP, SAVE_SENT,
  addDays, cellAriaLabel, cellLabels, cellState, cellText, confirmable, confirmedMessage, dayKeyOf, dayLabel, dayParts,
  daySlots, isMeetingOver, isSlotKey, isTimeNotShared, meetingStands, saveMessage, saveOutcome, schedulerError,
  slotLabel, slotTime, typedSlot, upcomingDays, whenWithZone, zoneLine, zoneName,
  type SchedulingLike,
} from '../../../../client/src/features/messages/scheduler-flow';

const CPH = 'Europe/Copenhagen';
const NYC = 'America/New_York';
const at = (iso: string) => Date.parse(iso);
const times = (slots: string[], zone: string) => slots.map((k) => slotTime(k, zone));
const gapsMin = (slots: string[]) => slots.slice(1).map((k, i) => (at(k) - at(slots[i])) / 60_000);

describe('a day is every half hour from midnight to midnight, on the clock of the zone it is drawn in', () => {
  it('an ordinary day in Copenhagen: 48 half hours, 00:00 to 23:30, each a key the server stores', () => {
    const slots = daySlots('2026-10-27', CPH);
    expect(slots).toHaveLength(48);
    expect(slots[0]).toBe('2026-10-26T23:00:00Z');
    expect(slots[47]).toBe('2026-10-27T22:30:00Z');
    expect(slots.every(isSlotKey)).toBe(true);
    expect(new Set(slots).size).toBe(48);
    expect(gapsMin(slots).every((g) => g === 30)).toBe(true);
    expect(times(slots, CPH).slice(0, 3)).toEqual(['00:00', '00:30', '01:00']);
    expect(times(slots, CPH)[47]).toBe('23:30');
  });

  it('29 March 2026, the clocks go forward: 46 half hours, no 02:00 or 02:30, and nothing twice', () => {
    const slots = daySlots('2026-03-29', CPH);
    expect(slots).toHaveLength(46);
    expect(new Set(slots).size).toBe(46);
    expect(slots[0]).toBe('2026-03-28T23:00:00Z');
    expect(slots[45]).toBe('2026-03-29T21:30:00Z');
    expect(times(slots, CPH).slice(0, 6)).toEqual(['00:00', '00:30', '01:00', '01:30', '03:00', '03:30']);
    expect(times(slots, CPH)).not.toContain('02:00');
    expect(times(slots, CPH)).not.toContain('02:30');
    // One instant per cell: the old wall-clock build gave 02:00 and 03:00 the same key, so one tap toggled two cells.
    expect(gapsMin(slots).every((g) => g === 30)).toBe(true);
    expect(new Set(cellLabels(slots, CPH)).size).toBe(46);
  });

  it('25 October 2026, the clocks go back: 50 half hours, 02:00 and 02:30 twice, each told apart by its zone', () => {
    const slots = daySlots('2026-10-25', CPH);
    expect(slots).toHaveLength(50);
    expect(new Set(slots).size).toBe(50);
    expect(slots[0]).toBe('2026-10-24T22:00:00Z');
    expect(slots[49]).toBe('2026-10-25T22:30:00Z');
    expect(gapsMin(slots).every((g) => g === 30)).toBe(true);
    // The repeated hour has cells for both of its times (the old build had none for the second).
    expect(slots).toEqual(expect.arrayContaining([
      '2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:00:00Z', '2026-10-25T01:30:00Z',
    ]));
    const labels = cellLabels(slots, CPH);
    expect(new Set(labels).size).toBe(50);
    expect(labels.slice(4, 8)).toEqual(['02:00 CEST', '02:30 CEST', '02:00 CET', '02:30 CET']);
    expect(labels.slice(0, 4)).toEqual(['00:00', '00:30', '01:00', '01:30']);
    // Stefan's 13:00 that day is the instant both of them saved.
    expect(slots).toContain('2026-10-25T12:00:00Z');
    expect(slotTime('2026-10-25T12:00:00Z', CPH)).toBe('13:00');
  });

  it('the same on both of New York\'s 2026 changes (8 March forward, 1 November back)', () => {
    const spring = daySlots('2026-03-08', NYC);
    expect(spring).toHaveLength(46);
    expect(new Set(spring).size).toBe(46);
    expect(times(spring, NYC)).not.toContain('02:00');
    const autumn = daySlots('2026-11-01', NYC);
    expect(autumn).toHaveLength(50);
    expect(new Set(autumn).size).toBe(50);
    expect(new Set(cellLabels(autumn, NYC)).size).toBe(50);
    expect(gapsMin(autumn).every((g) => g === 30)).toBe(true);
  });

  it('zones with no clock change, half-hour and quarter-hour offsets, and UTC itself', () => {
    expect(daySlots('2026-10-27', 'Asia/Karachi')[0]).toBe('2026-10-26T19:00:00Z');
    expect(daySlots('2026-10-27', 'Asia/Kolkata')[0]).toBe('2026-10-26T18:30:00Z');
    expect(daySlots('2026-10-27', 'UTC')[0]).toBe('2026-10-27T00:00:00Z');
    // Kathmandu is 5:45 ahead: its cells sit on UTC's half hours (the only times the server accepts), at :15 and :45.
    const ktm = daySlots('2026-10-27', 'Asia/Kathmandu');
    expect(ktm).toHaveLength(48);
    expect(ktm[0]).toBe('2026-10-26T18:30:00Z');
    expect(slotTime(ktm[0], 'Asia/Kathmandu')).toBe('00:15');
    expect(ktm.every((k) => new Date(k).getUTCMinutes() % 30 === 0)).toBe(true);
    for (const zone of ['Asia/Karachi', 'Asia/Kolkata', 'UTC']) expect(daySlots('2026-10-27', zone)).toHaveLength(48);
  });

  it('a day the zone does not have returns nothing, and a malformed day key is nothing too', () => {
    expect(daySlots('2026-13-40', CPH)).toEqual([]);
    expect(daySlots('tomorrow', CPH)).toEqual([]);
  });
});

describe('the days on offer', () => {
  it('starts today in the zone and runs on day by day, through the clock change, with no day twice or missing', () => {
    expect(upcomingDays(at('2026-10-23T10:00:00Z'), CPH, 7))
      .toEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']);
  });

  it('leaves today out once its last half hour has started: late at night there is nothing left to pick', () => {
    // 23:40 in Copenhagen on 24 Oct; 23:30 has started.
    expect(upcomingDays(at('2026-10-24T21:40:00Z'), CPH, 3)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
  });

  it('an instant\'s day is the zone\'s day, not UTC\'s', () => {
    expect(dayKeyOf('2026-10-24T22:30:00Z', CPH)).toBe('2026-10-25');
    expect(dayKeyOf('2026-10-24T22:30:00Z', 'UTC')).toBe('2026-10-24');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
  });
});

describe('the words: times, days and the zone, in the form the emails and bells use', () => {
  it('an instant reads "Sun 25 Oct, 13:00" on the reader\'s clock, with the day never padded and September as "Sep"', () => {
    expect(slotLabel('2026-10-25T12:00:00Z', CPH)).toBe('Sun 25 Oct, 13:00');
    expect(slotLabel('2026-10-25T12:00:00.000Z', CPH)).toBe('Sun 25 Oct, 13:00');
    expect(slotLabel('2026-09-05T10:00:00Z', CPH)).toBe('Sat 5 Sep, 12:00');
    expect(slotLabel('2026-10-25T12:00:00Z', 'Asia/Karachi')).toBe('Sun 25 Oct, 17:00');
    expect(whenWithZone('2026-10-25T12:00:00Z', CPH)).toBe('Sun 25 Oct, 13:00 CET');
    expect(whenWithZone('2026-07-15T12:00:00Z', CPH)).toBe('Wed 15 Jul, 14:00 CEST');
  });

  it('a day on the strip reads "Sun" over "25 Oct", and "Sun 25 Oct" in a sentence', () => {
    expect(dayParts('2026-10-25')).toEqual({ weekday: 'Sun', date: '25 Oct' });
    expect(dayParts('2026-09-01')).toEqual({ weekday: 'Tue', date: '1 Sep' });
    expect(dayLabel('2026-10-25')).toBe('Sun 25 Oct');
  });

  it('names the zone: "Times in your time zone: Central European Time (CET)"', () => {
    expect(zoneName(CPH, at('2026-10-26T12:00:00Z'))).toBe('Central European Time (CET)');
    expect(zoneName(CPH, at('2026-07-15T12:00:00Z'))).toBe('Central European Time (CEST)');
    expect(zoneName('UTC', at('2026-10-26T12:00:00Z'))).toBe('Coordinated Universal Time (UTC)');
    expect(zoneName('Asia/Karachi', at('2026-10-26T12:00:00Z'))).toMatch(/^Pakistan .*Time \(GMT\+5\)$/);
    expect(zoneLine(CPH, at('2026-10-26T12:00:00Z'))).toBe('Times in your time zone: Central European Time (CET)');
  });
});

describe('"Another time": a typed time is the slot it means on that day', () => {
  it('a whole or half hour is that slot, on the day picked, in the zone', () => {
    expect(typedSlot('2026-10-25', '13:00', CPH)).toBe('2026-10-25T12:00:00Z');
    expect(typedSlot('2026-10-27', '9:30', CPH)).toBe('2026-10-27T08:30:00Z');
    expect(typedSlot('2026-10-27', ' 21:30 ', CPH)).toBe('2026-10-27T20:30:00Z');
  });

  it('any other minute goes to the nearest half hour, a tie to the later one, and nothing leaves the day', () => {
    expect(typedSlot('2026-10-27', '13:14', CPH)).toBe('2026-10-27T12:00:00Z');
    expect(typedSlot('2026-10-27', '13:15', CPH)).toBe('2026-10-27T12:30:00Z');
    expect(typedSlot('2026-10-27', '23:50', CPH)).toBe('2026-10-27T22:30:00Z');
  });

  it('on the clock-change nights: a time that does not exist goes to the nearest that does, a repeated one to the first', () => {
    expect(typedSlot('2026-03-29', '02:30', CPH)).toBe('2026-03-29T01:00:00Z'); // 03:00 CEST
    expect(typedSlot('2026-10-25', '02:30', CPH)).toBe('2026-10-25T00:30:00Z'); // 02:30 CEST, the first of the two
  });

  it('anything that is not a time is nothing', () => {
    for (const typed of ['', '25:00', '12:60', 'ab', '1300', '12:3']) expect(typedSlot('2026-10-27', typed, CPH)).toBeNull();
  });
});

describe('what can be confirmed, and when a meeting stands', () => {
  const now = at('2026-10-25T11:45:00Z');

  it('only shared slots that start after now, earliest first (the server refuses a time that has started)', () => {
    expect(confirmable(['2026-10-25T13:00:00Z', '2026-10-25T12:00:00Z', '2026-10-25T11:30:00Z', '2026-10-25:evening'], now))
      .toEqual(['2026-10-25T12:00:00Z', '2026-10-25T13:00:00Z']);
    expect(confirmable(['2026-10-25T11:45:00Z'], now)).toEqual([]);
  });

  it('a meeting stands until 30 minutes after it should have ended; a day part with no time stands', () => {
    const meeting = { window: '2026-10-25T12:00:00Z', startAt: '2026-10-25T12:00:00.000Z', durationMin: 30 };
    expect(meetingStands(meeting, at('2026-10-25T13:00:00Z'))).toBe(true);
    expect(meetingStands(meeting, at('2026-10-25T13:00:01Z'))).toBe(false);
    expect(isMeetingOver(meeting.startAt, 30, at('2026-10-25T13:00:01Z'))).toBe(true);
    expect(isMeetingOver(null, null, now)).toBe(false);
    expect(meetingStands({ window: '2026-10-25:evening', startAt: null, durationMin: null }, now)).toBe(true);
    expect(meetingStands(null, now)).toBe(false);
  });
});

describe('a cell: what it shows, what it says to a screen reader, and what a tap on it does', () => {
  const k = '2026-10-25T12:00:00Z';
  const state = (mine: string[], saved: string[], theirs: string[], booked: string | null = null) =>
    cellState({ key: k, mine: new Set(mine), saved: new Set(saved), theirs: new Set(theirs), booked });

  it('green is a time BOTH saved: it is the confirm control, "Confirm 13:00, you both can"', () => {
    expect(state([k], [k], [k])).toBe('agreed');
    expect(cellText('agreed')).toBe('Both can');
    expect(cellAriaLabel('agreed', '13:00')).toBe('Confirm 13:00, you both can');
  });

  it('their time I tapped but have not sent is mine until I send it, so a second tap takes it back', () => {
    expect(state([k], [], [k])).toBe('unsent-both');
    expect(cellAriaLabel('unsent-both', '13:00')).toBe('13:00, you both can, not sent yet');
  });

  it('the rest: mine, theirs, free, and the booked meeting itself', () => {
    expect(state([k], [k], [])).toBe('mine');
    expect(state([], [], [k])).toBe('theirs');
    expect(state([], [], [])).toBe('free');
    expect(state([k], [k], [k], k)).toBe('booked');
    expect([cellText('mine'), cellText('theirs'), cellText('free'), cellText('booked')]).toEqual(['You', 'They can', '', 'Booked']);
    expect(cellAriaLabel('booked', '13:00')).toBe('13:00, your meeting');
    expect(cellAriaLabel('theirs', '13:00')).toBe('13:00, they can');
    expect(cellAriaLabel('mine', '13:00')).toBe('13:00, you can');
    expect(cellAriaLabel('free', '13:00')).toBe('13:00');
  });
});

describe('what a Save says it did, read from the answer the save itself got', () => {
  const now = at('2026-10-25T11:45:47Z');
  const sched = (overlap: string[], confirmed: SchedulingLike['confirmed'] = null): SchedulingLike => ({ overlap, confirmed });
  const booked = { window: '2026-10-25T12:00:00Z', startAt: '2026-10-25T12:00:00.000Z', durationMin: 30 };

  it('the save booked the one time both picked: "Meeting confirmed: Sun 25 Oct, 13:00", and the panel closes', () => {
    const outcome = saveOutcome(sched([]), sched(['2026-10-25T12:00:00Z'], booked), now);
    expect(outcome).toEqual({ kind: 'confirmed', startAt: booked.startAt });
    expect(saveMessage(outcome, CPH)).toBe('Meeting confirmed: Sun 25 Oct, 13:00');
  });

  it('two or more shared times and no meeting: "You can both meet. Confirm a time." and the panel stays open', () => {
    const outcome = saveOutcome(sched([]), sched(['2026-10-25T12:00:00Z', '2026-10-25T13:00:00Z']), now);
    expect(outcome).toEqual({ kind: 'overlap' });
    expect(saveMessage(outcome, CPH)).toBe('You can both meet. Confirm a time.');
    expect(SAVE_OVERLAP).toBe('You can both meet. Confirm a time.');
  });

  it('nothing shared yet: "Sent. They can see when you are free."', () => {
    const outcome = saveOutcome(undefined, sched([]), now);
    expect(outcome).toEqual({ kind: 'sent' });
    expect(saveMessage(outcome, CPH)).toBe('Sent. They can see when you are free.');
    expect(SAVE_SENT).toBe('Sent. They can see when you are free.');
  });

  it('a meeting that already stood is not news: a save that shares nothing new just sends', () => {
    expect(saveOutcome(sched(['2026-10-25T12:00:00Z'], booked), sched(['2026-10-25T12:00:00Z'], booked), now))
      .toEqual({ kind: 'sent' });
  });

  it('Reschedule: with a meeting standing, the save that makes ONE more time shared moves the meeting there', () => {
    // Both picked 15:00 while 13:00 stood: that is the new agreement, the way the first one was.
    expect(saveOutcome(sched(['2026-10-25T12:00:00Z'], booked), sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z'], booked), now))
      .toEqual({ kind: 'move', to: '2026-10-25T14:00:00Z' });
    expect(saveMessage({ kind: 'move', to: '2026-10-25T14:00:00Z' }, CPH)).toBe('Meeting moved: Sun 25 Oct, 15:00');
  });

  it('Reschedule: two or more new shared times leave the choice to the person (the move step stays open); old ones are not new', () => {
    expect(saveOutcome(
      sched(['2026-10-25T12:00:00Z'], booked),
      sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z', '2026-10-25T16:00:00Z'], booked), now,
    )).toEqual({ kind: 'overlap' });
    // 14:00 was already shared before this save: nothing moves.
    expect(saveOutcome(
      sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z'], booked),
      sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z'], booked), now,
    )).toEqual({ kind: 'sent' });
  });

  it('only shared times still ahead count; once a meeting has ended, a new one booked by the save is news again', () => {
    expect(saveOutcome(sched([]), sched(['2026-10-25T11:30:00Z']), now)).toEqual({ kind: 'sent' });
    const ended = { window: '2026-10-20T12:00:00Z', startAt: '2026-10-20T12:00:00.000Z', durationMin: 30 };
    expect(saveOutcome(sched([], ended), sched(['2026-10-25T12:00:00Z'], booked), now)).toEqual({ kind: 'confirmed', startAt: booked.startAt });
    expect(saveOutcome(sched([], ended), sched(['2026-10-25T12:00:00Z', '2026-10-25T13:00:00Z'], ended), now)).toEqual({ kind: 'overlap' });
  });

  it('a confirm says what it did, and moving a meeting says so', () => {
    expect(confirmedMessage('2026-10-25T12:00:00Z', CPH, false)).toBe('Meeting confirmed: Sun 25 Oct, 13:00');
    expect(confirmedMessage('2026-10-27T15:00:00Z', CPH, true)).toBe('Meeting moved: Tue 27 Oct, 16:00');
  });
});

describe('when a request fails', () => {
  const answer = (status: number, code: string, message: string) => ({ response: { status, data: { error: { code, message } } } });

  it('a time no longer shared is recognised, and its sentence is the server\'s', () => {
    const err = answer(409, 'MEETING_TIME_NOT_SHARED', 'That time is no longer free for both of you.');
    expect(isTimeNotShared(err)).toBe(true);
    expect(schedulerError(err, 'Could not confirm that time.')).toBe(NOT_SHARED);
    expect(isTimeNotShared(answer(409, 'SOMETHING_ELSE', 'x'))).toBe(false);
  });

  it('no answer at all reads as the connection, and anything unfit to show reads as the fallback', () => {
    expect(schedulerError({ isAxiosError: true, request: {} }, 'Could not save your times. Try again.'))
      .toBe('Connection lost. Check your internet and try again.');
    expect(schedulerError(answer(500, 'INTERNAL', 'boom at /srv'), 'Could not save your times. Try again.'))
      .toBe('Could not save your times. Try again.');
  });
});

// ---- the screens, read from source -------------------------------------------------------------------------------

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
const scheduler = () => read('features/messages/MeetingScheduler.tsx');
const page = () => read('features/messages/MessagesPage.tsx');
const card = () => read('features/messages/SystemMessageCard.tsx');

describe('the scheduler on screen', () => {
  it('builds its days and cells from the zone-safe rules above, not from wall-clock Dates', () => {
    const src = scheduler();
    expect(src).toMatch(/from '\.\/scheduler-flow'/);
    expect(src).toMatch(/daySlots\(/);
    expect(src).not.toMatch(/new Date\(day\.getFullYear\(\), day\.getMonth\(\), day\.getDate\(\), h/);
  });

  it('a green cell opens the confirm card for its own time; it never toggles your pick away', () => {
    const src = scheduler();
    expect(src).toMatch(/state === 'agreed'\s*\?\s*openConfirm\(key\)\s*:\s*toggle\(key\)/);
    expect(src).toMatch(/aria-label=\{cellAriaLabel\(state, /);
  });

  it('hides the times that have started instead of greying them out with no reason', () => {
    expect(scheduler()).not.toMatch(/disabled=\{past\}/);
    expect(scheduler()).toMatch(/\.filter\(k => !hasStarted\(k, now\)\)/);
  });

  it('names the time zone over the times', () => {
    expect(scheduler()).toMatch(/data-testid="scheduler-zone"/);
    expect(scheduler()).toMatch(/zoneLine\(zone, now\)/);
  });

  it('keeps the length and Video or Audio inside the confirm card, the only place they are used', () => {
    const src = scheduler();
    const cardAt = src.indexOf('data-testid="confirm-card"');
    expect(cardAt).toBeGreaterThan(-1);
    expect(src.indexOf('id="meeting-minutes"')).toBeGreaterThan(cardAt);
    expect(src.indexOf("k === 'video' ? 'Video' : 'Audio'")).toBeGreaterThan(cardAt);
    expect(src.match(/id="meeting-minutes"/g)).toHaveLength(1);
  });

  it('sends the length and kind with Save, so a save that books the time books it with them', () => {
    expect(scheduler()).toMatch(/scheduling\/availability`, \{\s*windows,\s*\.\.\.\(durationOk \? \{ durationMin \} : \{\}\),\s*type: meetingKind,\s*\}\)/);
  });

  it('reads the Save\'s own answer to say what happened, and stays open when there is a time to confirm', () => {
    const src = scheduler();
    expect(src).toMatch(/const after = res\.data\.data as Scheduling;\s*const outcome = saveOutcome\(before, after, Date\.now\(\)\)/);
    expect(src).toMatch(/addToast\(saveMessage\(outcome, zone\), 'success'\)/);
    expect(src).toMatch(/if \(outcome\.kind === 'overlap'\)/);
  });

  it('never drops a typed "Another time": it is added on blur and on Enter, counts as unsaved, and rides with Save', () => {
    const src = scheduler();
    expect(src).toMatch(/onBlur=\{addTypedTime\}/);
    expect(src).toMatch(/if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); addTypedTime\(\); \}/);
    expect(src).toMatch(/const unsaved = stagedChanged \|\| typed !== null;/);
    expect(src).toMatch(/const windows = typed && !mine\.has\(typed\) \? \[\.\.\.mine, typed\] : \[\.\.\.mine\];/);
  });

  it('asks "Send your times?" (Send / Discard) before closing with unsaved times, whichever way it is closed', () => {
    const src = scheduler();
    expect(ASK_SEND).toBe('Send your times?');
    expect(src).toMatch(/\{ASK_SEND\}/);
    expect(src).toMatch(/>\s*Discard\s*</);
    expect(src).toMatch(/\{saving \? 'Sending…' : 'Send'\}/);
    expect(src).toMatch(/useImperativeHandle\(ref, \(\) => \(\{ requestClose \}\)\)/);
    expect(src).toMatch(/if \(unsaved\) \{ setAsking\(true\); return; \}/);
  });

  it('a 409 for a time no longer shared redraws the panel instead of leaving a dead card', () => {
    expect(scheduler()).toMatch(/if \(isTimeNotShared\(err\)\) \{\s*setFinalizing\(null\);/);
  });
});

describe('the thread: the card\'s time opens the confirm step for that time, and the panel never swallows the click', () => {
  it('passes the slot through (it used to be () => setSchedulerOpen(true), which threw the slot away)', () => {
    const src = page();
    expect(src).toMatch(/onPickSlot=\{\(slot\) => openSchedulerOn\(slot\)\}/);
    expect(src).not.toMatch(/onPickSlot=\{\(\) => setSchedulerOpen\(true\)\}/);
    expect(src).toMatch(/confirmRequest=\{confirmRequest\}/);
  });

  it('the outside-click closer skips the card\'s buttons, and asks the panel to close instead of closing it', () => {
    const src = page();
    expect(src).toMatch(/closest\('\[data-scheduler-panel\],\[data-scheduler-toggle\],\[data-scheduler-trigger\]'\)/);
    expect(src).toMatch(/schedulerRef\.current\??\.requestClose\(\)/);
    expect(card().match(/data-scheduler-trigger/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('a card never offers a time that has gone: live shared times once known, else the card\'s own, and only future ones', () => {
    expect(page()).toMatch(/liveSlots=\{scheduling \? confirmable\(scheduling\.overlap \?\? \[\], Date\.now\(\)\) : undefined\}/);
    expect(card()).toMatch(/\(liveSlots \?\? meta\.slots\)\.filter\(s => Date\.parse\(s\) > Date\.now\(\)\)/);
  });

  it('Reschedule from a meeting\'s page opens the scheduler (/messages/:id?schedule=1), once, for every pair', () => {
    const src = page();
    expect(src).toMatch(/searchParams\.get\('schedule'\) === '1'/);
    // Also a pair that has met: calls are unlocked and the scheduler is otherwise not offered to them.
    expect(src).toMatch(/activeConv && schedulerOpen && \(!callsUnlocked \|\| rescheduling\) && \(/);
    expect(src).toMatch(/setRescheduling\(true\);/);
    // The flag is dropped by replacing the entry, so Back does not open it again.
    expect(src).toMatch(/next\.delete\('schedule'\);\s*setSearchParams\(next, \{ replace: true \}\);/);
    // It opens with a time in view and in focus, ready for the first pick.
    expect(src).toMatch(/focusFirstPick=\{rescheduling\}/);
    expect(scheduler()).toMatch(/if \(focusFirstPick && !pickFocused\.current && pickEl && pick\) \{/);
    expect(scheduler()).toMatch(/pickEl\.focus\(\{ preventScroll: true \}\);/);
    // Not the booked time it opens on: the one after it.
    expect(scheduler()).toMatch(/const pick = target === bookedKey \? shown\[shown\.indexOf\(target\) \+ 1\]/);
  });

  it('a meeting card for a time that no longer stands (moved, or cancelled) says so and offers no Join', () => {
    expect(card()).toMatch(/const replaced = !over && currentMeeting !== undefined && !\(currentMeeting && sameInstant\(currentMeeting\.startAt, meta\.startAt\)\);/);
    expect(card()).toMatch(/\{!settled && \(/);
    expect(card()).toMatch(/'This meeting was cancelled\.' : 'This meeting moved to another time\.'/);
    expect(page()).toMatch(/currentMeeting=\{scheduling \? \(scheduling\.confirmed \? \{ startAt: scheduling\.confirmed\.startAt \?\? null \} : null\) : undefined\}/);
  });

  it('a save that agrees one new time while a meeting stands moves it there, keeping its length and kind', () => {
    const src = scheduler();
    expect(src).toMatch(/if \(outcome\.kind === 'move'\) \{\s*await moveAfterSave\(outcome\.to, after\.confirmed\);/);
    expect(src).toMatch(/durationMin: meeting\?\.durationMin \?\? 30, type: meeting\?\.type \?\? 'video'/);
  });

  it('the pinned meeting links to its own page once it has one', () => {
    expect(scheduler()).toMatch(/to=\{`\/meetings\/\$\{c\.meetingId\}`\}/);
  });
});
