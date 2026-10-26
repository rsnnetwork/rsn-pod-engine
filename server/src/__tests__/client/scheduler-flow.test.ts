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
  addDays, cardSeed, cellAriaLabel, cellLabels, cellState, cellText, confirmFailure, confirmable, confirmedMessage,
  dayKeyOf, dayLabel, dayParts,
  daySlots, isMeetingOver, isSlotKey, isTimeNotShared, meetingLength, meetingStands, saveMessage, saveOutcome,
  STARTED_TIME, cardBlock, cardClosedText, localizeMeetingText, sameMeeting,
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

  it('a meeting line in the thread is one text for both people, each reading it on their own clock', () => {
    expect(localizeMeetingText('📅 Meeting confirmed: 2026-10-25T12:00:00Z · 20 min video call', CPH))
      .toBe('📅 Meeting confirmed: Sun 25 Oct, 13:00 CET · 20 min video call');
    expect(localizeMeetingText('Moved from 2026-10-25T12:00:00.000Z', 'UTC')).toBe('Moved from Sun 25 Oct, 12:00 UTC');
    expect(localizeMeetingText('No time here.', CPH)).toBe('No time here.');
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
  const ME = 'u-claus';
  const PARTNER = 'u-stefan';
  const sched = (overlap: string[], confirmed: SchedulingLike['confirmed'] = null): SchedulingLike => ({ overlap, confirmed });
  const booked = { window: '2026-10-25T12:00:00Z', startAt: '2026-10-25T12:00:00.000Z', durationMin: 30, byUserId: ME };
  const ctx = (known: SchedulingLike['confirmed'] = null, added: string[] = []) => ({ me: ME, known, added });

  it('the save booked the one time both picked: "Meeting confirmed: Sun 25 Oct, 13:00", and the panel closes', () => {
    const outcome = saveOutcome(sched(['2026-10-25T12:00:00Z'], booked), ctx(null, ['2026-10-25T12:00:00Z']), now);
    expect(outcome).toEqual({ kind: 'confirmed', startAt: booked.startAt });
    expect(saveMessage(outcome, CPH)).toBe('Meeting confirmed: Sun 25 Oct, 13:00');
  });

  it('a meeting the PARTNER booked or moved meanwhile is never "Meeting confirmed" for this person: the server says who', () => {
    // The panel still showed 13:00 when the partner moved it to 15:00; this save only added 17:00.
    const moved = { window: '2026-10-25T14:00:00Z', startAt: '2026-10-25T14:00:00.000Z', durationMin: 30, byUserId: PARTNER };
    expect(saveOutcome(sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z'], moved), ctx(booked, ['2026-10-25T16:00:00Z']), now))
      .toEqual({ kind: 'sent' });
  });

  it('two or more shared times and no meeting: "You can both meet. Confirm a time." and the panel stays open', () => {
    const outcome = saveOutcome(sched(['2026-10-25T12:00:00Z', '2026-10-25T13:00:00Z']), ctx(), now);
    expect(outcome).toEqual({ kind: 'overlap' });
    expect(saveMessage(outcome, CPH)).toBe('You can both meet. Confirm a time.');
    expect(SAVE_OVERLAP).toBe('You can both meet. Confirm a time.');
  });

  it('nothing shared yet: "Sent. They can see when you are free."', () => {
    const outcome = saveOutcome(sched([]), ctx(), now);
    expect(outcome).toEqual({ kind: 'sent' });
    expect(saveMessage(outcome, CPH)).toBe('Sent. They can see when you are free.');
    expect(SAVE_SENT).toBe('Sent. They can see when you are free.');
  });

  it('a meeting that already stood is not news: a save that shares nothing new just sends', () => {
    expect(saveOutcome(sched(['2026-10-25T12:00:00Z'], booked), ctx(booked), now)).toEqual({ kind: 'sent' });
  });

  it('a save never moves a meeting: ONE new shared time asks "Move the meeting there?" and the card opens on it', () => {
    // Both picked 15:00 while 13:00 stood. The member's own added time is what became shared.
    const outcome = saveOutcome(
      sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z'], booked), ctx(booked, ['2026-10-25T14:00:00Z']), now,
    );
    expect(outcome).toEqual({ kind: 'move', to: '2026-10-25T14:00:00Z' });
    expect(saveMessage(outcome, CPH)).toBe('You can both meet at Sun 25 Oct, 15:00. Move the meeting there?');
    expect(saveMessage(outcome, CPH)).not.toMatch(/Meeting (confirmed|moved)/);
  });

  it('two or more new shared times say there is a choice of where to move it; shared times the member did not add are not new', () => {
    const two = saveOutcome(
      sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z', '2026-10-25T16:00:00Z'], booked),
      ctx(booked, ['2026-10-25T14:00:00Z', '2026-10-25T16:00:00Z']), now,
    );
    expect(two).toEqual({ kind: 'move-choice' });
    expect(saveMessage(two, CPH)).toBe('You can both meet at other times too. Pick one to move the meeting.');
    expect(saveMessage(two, CPH)).not.toBe(SAVE_OVERLAP);
    // 14:00 was shared already (the member added only 17:30, which the partner does not have): nothing to move to.
    expect(saveOutcome(sched(['2026-10-25T12:00:00Z', '2026-10-25T14:00:00Z'], booked), ctx(booked, ['2026-10-25T16:30:00Z']), now))
      .toEqual({ kind: 'sent' });
  });

  it('only shared times still ahead count; once a meeting has ended, a new one booked by the save is news again', () => {
    expect(saveOutcome(sched(['2026-10-25T11:30:00Z']), ctx(), now)).toEqual({ kind: 'sent' });
    const ended = { window: '2026-10-20T12:00:00Z', startAt: '2026-10-20T12:00:00.000Z', durationMin: 30, byUserId: ME };
    expect(saveOutcome(sched(['2026-10-25T12:00:00Z'], booked), ctx(ended, ['2026-10-25T12:00:00Z']), now))
      .toEqual({ kind: 'confirmed', startAt: booked.startAt });
    expect(saveOutcome(sched(['2026-10-25T12:00:00Z', '2026-10-25T13:00:00Z'], ended), ctx(ended), now)).toEqual({ kind: 'overlap' });
  });

  it('a confirm says what it did, and moving a meeting says so', () => {
    expect(confirmedMessage('2026-10-25T12:00:00Z', CPH, false)).toBe('Meeting confirmed: Sun 25 Oct, 13:00');
    expect(confirmedMessage('2026-10-27T15:00:00Z', CPH, true)).toBe('Meeting moved: Tue 27 Oct, 16:00');
  });
});

describe('the confirm card for a meeting that stands keeps its length and kind', () => {
  const now = at('2026-10-25T11:45:47Z');

  it('a 45-minute audio meeting opens the Move card at 45 minutes, audio', () => {
    const standing = { window: '2026-10-25T12:00:00Z', startAt: '2026-10-25T12:00:00.000Z', durationMin: 45, type: 'audio' as const };
    expect(cardSeed(standing, now)).toEqual({ duration: '45', kind: 'audio' });
    expect(cardSeed({ ...standing, durationMin: null, type: null }, now)).toEqual({ duration: '30', kind: 'video' });
  });

  it('with no meeting standing (none, or one that has ended) the card keeps what the member chose', () => {
    expect(cardSeed(null, now)).toBeNull();
    const ended = { window: '2026-10-20T12:00:00Z', startAt: '2026-10-20T12:00:00.000Z', durationMin: 45, type: 'audio' as const };
    expect(cardSeed(ended, now)).toBeNull();
  });

  it('a typed length is whole minutes from 5 to 240, the bounds the server keeps', () => {
    expect(meetingLength('45')).toBe(45);
    expect(meetingLength('5')).toBe(5);
    expect(meetingLength('240')).toBe(240);
    for (const bad of ['', '4', '241', '30.5', 'abc', '-30']) expect(meetingLength(bad)).toBeNull();
  });
});

describe('a card whose meeting changed under it closes, and says where the meeting is now', () => {
  const now = at('2026-10-26T08:00:00Z');
  const meeting = (startAt: string, durationMin = 30, type: 'audio' | 'video' = 'video') =>
    ({ window: startAt.replace('.000Z', 'Z'), startAt, durationMin, type });

  it('the same meeting, or none on either side, has not changed', () => {
    expect(sameMeeting(null, null, now)).toBe(true);
    expect(sameMeeting(meeting('2026-10-29T09:00:00.000Z', 45, 'audio'), meeting('2026-10-29T09:00:00.000Z', 45, 'audio'), now)).toBe(true);
    // One that has ended is no meeting.
    expect(sameMeeting(meeting('2026-10-20T09:00:00.000Z'), null, now)).toBe(true);
  });

  it('a booking, a move, a new length or kind, or a cancel is a change', () => {
    const standing = meeting('2026-10-29T09:00:00.000Z', 45, 'audio');
    expect(sameMeeting(null, standing, now)).toBe(false);
    expect(sameMeeting(standing, meeting('2026-10-29T15:00:00.000Z', 45, 'audio'), now)).toBe(false);
    expect(sameMeeting(standing, meeting('2026-10-29T09:00:00.000Z', 30, 'audio'), now)).toBe(false);
    expect(sameMeeting(standing, meeting('2026-10-29T09:00:00.000Z', 45, 'video'), now)).toBe(false);
    expect(sameMeeting(standing, null, now)).toBe(false);
  });

  it('booked onto the card\'s own time (both pressed it, or both pressed Move): "Booked for {time}."', () => {
    expect(cardClosedText('2026-10-29T09:00:00Z', meeting('2026-10-29T09:00:00.000Z'), CPH, now)).toBe('Booked for Thu 29 Oct, 10:00.');
  });

  it('moved or changed elsewhere names the new time; a cancel says so', () => {
    expect(cardClosedText('2026-10-29T09:00:00Z', meeting('2026-10-30T11:00:00.000Z'), CPH, now)).toBe('Your meeting is now on Fri 30 Oct, 12:00.');
    expect(cardClosedText('2026-10-29T09:00:00Z', null, CPH, now)).toBe('Your meeting was cancelled.');
  });
});

describe('what the card says stands in the way, only when it is true', () => {
  const slot = '2026-10-29T09:00:00Z';
  const before = at('2026-10-26T08:00:00Z');

  it('nothing, while both still have the time saved', () => {
    expect(cardBlock(slot, { now: before, bothSaved: true, freshSinceOpen: true })).toBeNull();
  });

  it('"no longer free for both" only on an answer from the server newer than the card', () => {
    expect(cardBlock(slot, { now: before, bothSaved: false, freshSinceOpen: true })).toBe(NOT_SHARED);
    // The answer the card opened on (a save whose refetch failed, say) is no evidence either way.
    expect(cardBlock(slot, { now: before, bothSaved: false, freshSinceOpen: false })).toBeNull();
  });

  it('a time that has started says so, not that it is no longer shared', () => {
    expect(cardBlock(slot, { now: at('2026-10-29T09:00:00Z'), bothSaved: true, freshSinceOpen: true })).toBe(STARTED_TIME);
    expect(cardBlock(slot, { now: at('2026-10-29T09:10:00Z'), bothSaved: false, freshSinceOpen: true })).toBe(STARTED_TIME);
    expect(STARTED_TIME).toBe('That time has started. Pick a later one.');
  });
});

describe('a Move or a Confirm that fails says why, and where the meeting is', () => {
  const answer = (status: number, code: string, message: string, details?: unknown) =>
    ({ response: { status, data: { error: { code, message, details } } } });
  const now = at('2026-10-26T08:00:00Z');
  const stays = '2026-10-29T09:00:00.000Z';
  const dropped = { isAxiosError: true, request: {} };
  const move = { moving: true, stays, zone: CPH, now };
  const book = { moving: false, stays: null, zone: CPH, now };

  it('a time taken back names where the meeting is, as the refusal itself says (not what the panel had cached)', () => {
    const elsewhere = {
      overlap: [], confirmed: { window: '2026-10-30T11:00:00Z', startAt: '2026-10-30T11:00:00.000Z', durationMin: 30, type: 'video' },
    };
    expect(confirmFailure(answer(409, 'MEETING_TIME_NOT_SHARED', NOT_SHARED, { scheduling: elsewhere }), move))
      .toBe('That time is no longer free for both of you. Your meeting is on Fri 30 Oct, 12:00.');
    const none = { overlap: [], confirmed: null };
    expect(confirmFailure(answer(409, 'MEETING_TIME_NOT_SHARED', NOT_SHARED, { scheduling: none }), book)).toBe(NOT_SHARED);
  });

  it('no answer, or the server\'s own fault: nothing moved, try again', () => {
    expect(confirmFailure(dropped, move)).toBe('Could not move the meeting. It stays on Thu 29 Oct, 10:00. Try again.');
    expect(confirmFailure(answer(503, 'UNAVAILABLE', 'upstream down at /srv'), move))
      .toBe('Could not move the meeting. It stays on Thu 29 Oct, 10:00. Try again.');
    expect(confirmFailure(dropped, book)).toBe('Connection lost. Check your internet and try again.');
    expect(confirmFailure(answer(500, 'INTERNAL', 'boom'), book)).toBe('Could not confirm that time. Try again.');
  });

  it('a refusal says the server\'s own reason (blocked, a time in the past, too many tries), never "try again"', () => {
    expect(confirmFailure(answer(403, 'AUTH_FORBIDDEN', 'You can no longer arrange a meeting with this person'), move))
      .toBe('You can no longer arrange a meeting with this person. Your meeting stays on Thu 29 Oct, 10:00.');
    expect(confirmFailure(answer(400, 'VALIDATION_ERROR', 'Meeting time must be in the future'), book))
      .toBe('Meeting time must be in the future.');
    expect(confirmFailure(answer(429, 'RATE_LIMITED', 'Too many requests'), move))
      .toBe('Slow down a moment, then try again. Your meeting stays on Thu 29 Oct, 10:00.');
  });
});

describe('when a request fails', () => {
  const answer = (status: number, code: string, message: string) => ({ response: { status, data: { error: { code, message } } } });

  it('a time no longer shared is recognised by its code', () => {
    expect(isTimeNotShared(answer(409, 'MEETING_TIME_NOT_SHARED', 'That time is no longer free for both of you.'))).toBe(true);
    expect(isTimeNotShared(answer(409, 'SOMETHING_ELSE', 'x'))).toBe(false);
    expect(isTimeNotShared({ isAxiosError: true, request: {} })).toBe(false);
  });
});

// ---- the screens, read from source -------------------------------------------------------------------------------

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');
// The scheduler is a container (state and what each action does) and focused parts; the pins read them together.
const SCHEDULER_PARTS = [
  'MeetingScheduler.tsx', 'SchedulerConfirmCard.tsx', 'SchedulerSaveBar.tsx', 'SchedulerSlotGrid.tsx', 'SchedulerDayStrip.tsx',
  'SchedulerTypedTime.tsx', 'SchedulerOverlapList.tsx', 'SchedulerMeetingSummary.tsx', 'SchedulerLoadState.tsx',
  'useSchedulerScroll.ts', 'useSchedulerData.ts', 'useSchedulerDraft.ts', 'useSchedulerActions.ts',
];
// The container's own logic: the panel (MeetingScheduler.tsx) and the hooks that hold its state and actions.
const CONTAINER_FILES = ['MeetingScheduler.tsx', 'useSchedulerData.ts', 'useSchedulerDraft.ts', 'useSchedulerActions.ts'];
const part = (file: string) => read(`features/messages/${file}`);
const container = () => CONTAINER_FILES.map(part).join('\n');
const scheduler = () => SCHEDULER_PARTS.map(part).join('\n');
const page = () => read('features/messages/MessagesPage.tsx');
const card = () => read('features/messages/SystemMessageCard.tsx');
/** The body of `const name = (...) => {` up to its closing brace at the same indent. */
const handler = (src: string, name: string) => {
  const start = src.indexOf(`  const ${name} = `);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n  };', start));
};

describe('the scheduler on screen', () => {
  it('is a container and focused parts: the confirm card, the Save bar, the timeline, the day strip and the rest', () => {
    const src = container();
    for (const file of SCHEDULER_PARTS.slice(1)) {
      const name = file.replace(/\.tsx?$/, '');
      expect(src).toMatch(new RegExp(`from '\\./${name}'`));
    }
    // The parts hold the markup: the container no longer draws a card, a cell or the prompt itself.
    expect(src).not.toMatch(/data-testid="confirm-card"/);
    expect(src).not.toMatch(/data-slot=\{key\}/);
    expect(src).not.toMatch(/\{ASK_SEND\}/);
  });

  it('the panel itself stays a small component: its state and actions live in hooks (the 200-line rule)', () => {
    const panel = part('MeetingScheduler.tsx');
    expect(panel.split('\n').length).toBeLessThan(200);
    for (const hook of ['useSchedulerData', 'useSchedulerDraft', 'useSchedulerActions']) {
      expect(panel).toMatch(new RegExp(`const \\w+ = ${hook}\\(`));
    }
    // No action of its own: saving, confirming and discarding are the actions hook's.
    expect(panel).not.toMatch(/const (save|confirm|discard|openConfirm|showCard) = /);
  });

  it('one shared extractor says what a failed request means: the scheduler keeps none of its own', () => {
    expect(read('features/messages/scheduler-flow.ts')).not.toMatch(/export function schedulerError/);
    expect(handler(container(), 'save')).toMatch(/addToast\(errorMessage\(err, 'Could not save your times\. Try again\.'\), 'error'\);/);
    expect(read('features/messages/scheduler-flow.ts')).toMatch(/import \{ errorMessage \} from '\.\.\/reason\/errors';/);
  });

  it('builds its days and cells from the zone-safe rules above, not from wall-clock Dates', () => {
    const src = scheduler();
    expect(src).toMatch(/from '\.\/scheduler-flow'/);
    expect(src).toMatch(/daySlots\(/);
    expect(src).not.toMatch(/new Date\(day\.getFullYear\(\), day\.getMonth\(\), day\.getDate\(\), h/);
  });

  it('a green cell opens the confirm card for its own time; it never toggles your pick away', () => {
    expect(container()).toMatch(/state === 'agreed'\s*\?\s*openConfirm\(key\)\s*:\s*toggle\(key\)/);
    expect(part('SchedulerSlotGrid.tsx')).toMatch(/aria-label=\{cellAriaLabel\(state, /);
    expect(part('SchedulerSlotGrid.tsx')).toMatch(/onClick=\{\(\) => onPress\(state, key\)\}/);
    expect(container()).toMatch(/onPress=\{pressCell\}/);
  });

  it('hides the times that have started instead of greying them out with no reason', () => {
    expect(scheduler()).not.toMatch(/disabled=\{past\}/);
    expect(container()).toMatch(/\.filter\(k => !hasStarted\(k, now\)\)/);
  });

  it('names the time zone over the times', () => {
    expect(container()).toMatch(/data-testid="scheduler-zone"/);
    expect(container()).toMatch(/zoneLine\(zone, now\)/);
  });

  it('keeps the length and Video or Audio inside the confirm card, the only place they are used', () => {
    const src = part('SchedulerConfirmCard.tsx');
    const cardAt = src.indexOf('data-testid="confirm-card"');
    expect(cardAt).toBeGreaterThan(-1);
    expect(src.indexOf('id="meeting-minutes"')).toBeGreaterThan(cardAt);
    expect(src.indexOf("k === 'video' ? 'Video' : 'Audio'")).toBeGreaterThan(cardAt);
    expect(scheduler().match(/id="meeting-minutes"/g)).toHaveLength(1);
  });

  it('sends the length and kind with Save, so a save that books the time books it with them', () => {
    expect(container()).toMatch(/scheduling\/availability`, \{\s*windows,\s*\.\.\.\(durationOk \? \{ durationMin \} : \{\}\),\s*type: meetingKind,\s*\}\)/);
  });

  it('reads the Save\'s own answer, against what the server said before, to say what happened', () => {
    const save = handler(container(), 'save');
    // The meeting as the server last said it, and the times this save adds, are taken before the request…
    expect(save).toMatch(/const known = data\.confirmed;/);
    expect(save).toMatch(/const added = windows\.filter\(w => !savedMine\.has\(w\)\);/);
    // …and the outcome is read from the save's own answer, which says who booked or moved the meeting.
    expect(save).toMatch(/const after = res\.data\.data as Scheduling;\s*const outcome = saveOutcome\(after, \{ me, known, added \}, Date\.now\(\)\);/);
    expect(save).not.toMatch(/saveOutcome\(before/);
    expect(save).toMatch(/addToast\(saveMessage\(outcome, zone\), asks \? 'info' : 'success'\);/);
    // With a choice to make (times to confirm, or where to move the meeting) the panel stays open on it.
    expect(save).toMatch(/if \(outcome\.kind === 'overlap' \|\| outcome\.kind === 'move-choice'\) \{/);
  });

  it('never drops a typed "Another time": it is added on blur and on Enter, counts as unsaved, and rides with Save', () => {
    const typed = part('SchedulerTypedTime.tsx');
    expect(typed).toMatch(/onBlur=\{onAdd\}/);
    expect(typed).toMatch(/if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); onAdd\(\); \}/);
    const src = container();
    expect(src).toMatch(/onAdd=\{addTypedTime\}/);
    expect(src).toMatch(/const unsaved = stagedChanged \|\| typed !== null;/);
    expect(src).toMatch(/const windows = typed && !mine\.has\(typed\) \? \[\.\.\.mine, typed\] : \[\.\.\.mine\];/);
  });

  it('asks "Send your times?" (Send / Discard) before closing with unsaved times, whichever way it is closed', () => {
    const bar = part('SchedulerSaveBar.tsx');
    expect(ASK_SEND).toBe('Send your times?');
    expect(bar).toMatch(/\{ASK_SEND\}/);
    expect(bar).toMatch(/>\s*Discard\s*</);
    expect(bar).toMatch(/\{saving \? 'Sending…' : 'Send'\}/);
    const src = container();
    expect(src).toMatch(/useImperativeHandle\(ref, \(\) => \(\{ requestClose \}\)\)/);
    expect(src).toMatch(/if \(unsaved\) \{ setAsking\(true\); return; \}/);
  });

  it('the question survives the typed time\'s blur, and Discard acts on the first press', () => {
    // The blur that adds a typed time is not an answer to "Send your times?" (it used to take the question away)…
    expect(handler(container(), 'addTypedTime')).not.toMatch(/setAsking/);
    // …and pressing Send or Discard does not move the focus first, so the panel never changes under the pointer.
    const bar = part('SchedulerSaveBar.tsx');
    const prompt = bar.slice(bar.indexOf('{ASK_SEND}'), bar.indexOf(') : ('));
    expect(prompt.match(/onMouseDown=\{keepFocus\}/g)).toHaveLength(2);
    expect(bar).toMatch(/const keepFocus = \(e: \{ preventDefault: \(\) => void \}\) => e\.preventDefault\(\);/);
  });

  it('a save never moves a meeting: one new shared time opens the Move card on it, and only Move moves it', () => {
    const save = handler(container(), 'save');
    expect(save).toMatch(/if \(outcome\.kind === 'move'\) \{[^}]*showCard\(outcome\.to, after\.confirmed\);\s*return;/);
    expect(scheduler()).not.toMatch(/moveAfterSave/);
    // The one request that books or moves a meeting is the card's button.
    expect(scheduler().match(/scheduling\/confirm`/g)).toHaveLength(1);
    expect(handler(container(), 'confirm')).toMatch(/scheduling\/confirm`/);
  });

  it('the card keeps a standing meeting\'s length and kind (a 45-minute audio meeting moves as one)', () => {
    const show = handler(container(), 'showCard');
    expect(show).toMatch(/const seed = cardSeed\(meeting, Date\.now\(\)\);/);
    expect(show).toMatch(/if \(seed\) \{ setDurationText\(seed\.duration\); setMeetingKind\(seed\.kind\); \}/);
    // Every way into the card goes through it: a green cell, a chip, the thread card's time, and a save.
    expect(handler(container(), 'openConfirm')).toMatch(/showCard\(slot, data\?\.confirmed\);/);
  });

  it('a failed Move or Confirm keeps the card open to retry, says why at once, and frees the button at once', () => {
    const confirm = handler(container(), 'confirm');
    // The card closes only once the request has succeeded; the success is said before the thread refreshes.
    expect(confirm).toMatch(/scheduling\/confirm`, \{ window: key, durationMin, type: meetingKind \}\);\s*setFinalizing\(null\);/);
    expect(confirm).toMatch(/addToast\(confirmedMessage\(key, zone, moving\), 'success'\);\s*void refreshThread\(\);/);
    // The failure is said first, from the refusal itself, and the refresh is not waited on (no await anywhere in the catch).
    const failure = confirm.slice(confirm.indexOf('} catch (err) {'), confirm.indexOf('} finally {'));
    expect(failure).toMatch(/const message = confirmFailure\(err, \{ moving, stays, zone, now: Date\.now\(\) \}\);/);
    expect(failure).toMatch(/addToast\(message, 'error'\);\s*void queryClient\.invalidateQueries\(\{ queryKey: schedulingKey\(conversationId\) \}\);/);
    expect(failure).not.toMatch(/await/);
    // A retry that works takes the failures it followed down.
    expect(confirm).toMatch(/setFinalizing\(null\);\s*dismissFailures\(\);/);
    expect(handler(container(), 'dismissFailures')).toMatch(/failureToasts\.current\.includes\(t\.message\)\) removeToast\(t\.id\)/);
  });

  it('the card states what stands in its way only when it is true: started, or no longer saved by both on a newer answer', () => {
    const src = container();
    expect(src).toMatch(/const cardReason = finalizing\s*\?\s*cardBlock\(finalizing, \{\s*now,\s*bothSaved: savedMine\.has\(finalizing\) && theirSet\.has\(finalizing\),\s*freshSinceOpen: !!cardBasis\.current && dataUpdatedAt > cardBasis\.current\.openedAt,/);
    expect(src).toMatch(/reason=\{act\.cardReason\}/);
    // Not "is it confirmable", which also drops the booked time and made a card on its own meeting say "no longer free".
    expect(src).not.toMatch(/stillShared/);
    const cardSrc = part('SchedulerConfirmCard.tsx');
    expect(cardSrc).toMatch(/disabled=\{busy \|\| minutes === null \|\| reason !== null\}/);
    expect(cardSrc).toMatch(/\{reason && \(\s*<p[^>]*data-testid="confirm-card-reason">\{reason\}<\/p>/);
  });

  it('a card whose meeting changes under it closes and says where the meeting is; this member\'s own request is not that', () => {
    const src = container();
    expect(handler(src, 'showCard')).toMatch(/cardBasis\.current = \{ meeting: meeting \?\? null, openedAt: Date\.now\(\) \};/);
    const effect = src.slice(src.indexOf('const basis = cardBasis.current;'));
    expect(effect).toMatch(/^const basis = cardBasis\.current;\s*if \(!finalizing \|\| !basis \|\| !data \|\| confirming \|\| saving\) return;\s*if \(sameMeeting\(basis\.meeting, data\.confirmed, now\)\) return;\s*setFinalizing\(null\);\s*addToast\(cardClosedText\(finalizing, data\.confirmed, zone, now\), 'info'\);/);
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
    const scroll = part('useSchedulerScroll.ts');
    expect(scroll).toMatch(/if \(focusFirstPick && !pickFocused\.current && pickEl && pick\) \{/);
    expect(scroll).toMatch(/pickEl\.focus\(\{ preventScroll: true \}\);/);
    // Not the booked time it opens on: the one after it.
    expect(scroll).toMatch(/const pick = target === bookedKey \? shown\[shown\.indexOf\(target\) \+ 1\]/);
  });

  it('a meeting card for a time that no longer stands (moved, or cancelled) says so and offers no Join', () => {
    expect(card()).toMatch(/const replaced = !over && currentMeeting !== undefined && !\(currentMeeting && sameInstant\(currentMeeting\.startAt, meta\.startAt\)\);/);
    expect(card()).toMatch(/\{!settled && \(/);
    expect(card()).toMatch(/'This meeting was cancelled\.' : 'This meeting moved to another time\.'/);
    expect(page()).toMatch(/currentMeeting=\{scheduling \? \(scheduling\.confirmed \? \{ startAt: scheduling\.confirmed\.startAt \?\? null \} : null\) : undefined\}/);
  });

  it('the pinned meeting links to its own page once it has one', () => {
    expect(read('features/messages/ThreadMeetingBanner.tsx')).toMatch(/to=\{`\/meetings\/\$\{c\.meetingId\}`\}/);
    expect(page()).toMatch(/import ThreadMeetingBanner from '\.\/ThreadMeetingBanner';/);
  });
});
