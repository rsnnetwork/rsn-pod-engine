// ─── Meeting Windows (REASON v1 Phase 2, 19 Jul 2026) ────────────────────────
//
// "Setup availability to be introduced": each side of a conversation picks
// time windows, overlap is computed, either side confirms an overlap window.
// Confirming writes the conversation columns, drops a message in the thread,
// and bell-notifies the partner.

const mockQuery = jest.fn();
const mockSendMessage = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
// 21 Sep 2026: the meeting loop now writes its own lines into the thread
// ("X shared times they can meet", "you are both free…", "meeting confirmed"),
// and the confirmed one is written INSIDE the confirm transaction so a meeting
// can never exist without the card that tells both people about it.
const mockInsertOn = jest.fn().mockResolvedValue({ message: { id: 'm1' }, conversationId: 'conv-1' });
jest.mock('../../../services/dm/dm.service', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  insertDirectMessageOn: (...args: unknown[]) => mockInsertOn(...args),
  __esModule: true,
}));
const mockAreBlocked = jest.fn().mockResolvedValue(false);
jest.mock('../../../services/block/block.service', () => ({
  areBlocked: (...args: unknown[]) => mockAreBlocked(...args),
  __esModule: true,
}));
jest.mock('../../../index', () => ({
  io: { to: () => ({ emit: () => {} }) },
  __esModule: true,
}));
// confirmWindow now fans the confirmation message out through broadcastDmMessage
// (notify:false — the meeting_confirmed bell is inserted separately). acceptPoke
// does the same for its intro; mock it here so importing poke.service is safe.
const mockBroadcastDm = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  broadcastDmMessage: (...args: unknown[]) => mockBroadcastDm(...args),
  __esModule: true,
}));

// W6: an exact-time confirm emails both people an .ics invite. Mock the
// calendar + email services so we can assert the invite is sent without hitting
// Resend.
const mockSendMtgEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/calendar/calendar.service', () => ({
  generateIcsContent: () => 'ICSCONTENT',
  buildGoogleCalendarUrl: () => 'https://calendar.google.com/x',
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({
  sendMeetingConfirmedEmail: (...args: unknown[]) => mockSendMtgEmail(...args),
  __esModule: true,
}));

import {
  isValidWindowKey, windowLabel, getScheduling, setAvailability, confirmWindow,
  markSchedulerSeen, HORIZON_DAYS, meetingUid, isMeetingOver, isPastKey,
} from '../../../services/dm/meeting-windows.service';

const NOW = new Date('2026-07-19T12:00:00Z');
const key = (offsetDays: number, part = 'morning') => {
  const d = new Date(NOW.getTime() + offsetDays * 86_400_000);
  return `${d.toISOString().slice(0, 10)}:${part}`;
};

// Service tests validate against the real clock, not the injected NOW. Compute dates dynamically.
const futureKey = (daysAhead: number, part: 'morning' | 'afternoon' | 'evening' = 'morning') => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.toISOString().slice(0, 10)}:${part}`;
};

const CONV = {
  id: 'conv-1', user_a_id: 'u-a', user_b_id: 'u-b',
  meeting_confirmed_window: null, meeting_confirmed_by: null, meeting_confirmed_at: null,
};

function armConv(availRows: Array<{ user_id: string; window_key: string }>, conv: any = CONV) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [conv] });
    if (/FROM meeting_availability/.test(sql)) return Promise.resolve({ rows: availRows });
    if (/SELECT id, display_name, email, timezone FROM users/.test(sql)) return Promise.resolve({ rows: [
      { id: 'u-a', display_name: 'A', email: null, timezone: 'Asia/Karachi' },
      { id: 'u-b', display_name: 'B', email: null, timezone: 'Europe/Berlin' },
    ] });
    return Promise.resolve({ rows: [{ id: 'n1', created_at: NOW }] });
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSendMessage.mockReset();
  mockInsertOn.mockClear();
  mockInsertOn.mockResolvedValue({ message: { id: 'm1' }, conversationId: 'conv-1' });
  mockAreBlocked.mockClear();
  mockAreBlocked.mockResolvedValue(false);
});

/**
 * setAvailability reads the table, writes, then reads again to see whether the
 * overlap just came into existence. A static mock cannot tell those apart, so
 * this one answers the FIRST read with what was there before and every later
 * read with what my save leaves behind.
 */
function armSave(before: Array<{ user_id: string; window_key: string }>, after: Array<{ user_id: string; window_key: string }>, conv: any = CONV) {
  let reads = 0;
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [conv] });
    if (/FROM meeting_availability/.test(sql)) {
      reads += 1;
      return Promise.resolve({ rows: reads === 1 ? before : after });
    }
    if (/SELECT display_name FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ display_name: 'Ana' }] });
    if (/SELECT id, display_name, email, timezone FROM users/.test(sql)) return Promise.resolve({ rows: [
      { id: 'u-a', display_name: 'A', email: null, timezone: 'Asia/Karachi' },
      { id: 'u-b', display_name: 'B', email: null, timezone: 'Europe/Berlin' },
    ] });
    return Promise.resolve({ rows: [{ id: 'n1', created_at: NOW }] });
  });
}

/** The content of the Nth system card written into the thread. */
const cardContent = (n = 0) => (mockInsertOn.mock.calls[n] as unknown[])[3] as string;
/** The system_meta of the Nth card. */
const cardMeta = (n = 0) => ((mockInsertOn.mock.calls[n] as unknown[])[5] as { systemMeta?: unknown }).systemMeta;

describe('isValidWindowKey', () => {
  it('accepts today through the horizon, all dayparts', () => {
    expect(isValidWindowKey(key(0), NOW)).toBe(true);
    expect(isValidWindowKey(key(7, 'evening'), NOW)).toBe(true);
    expect(isValidWindowKey(key(HORIZON_DAYS, 'afternoon'), NOW)).toBe(true);
  });
  it('rejects the past, beyond-horizon, bad formats, and impossible dates', () => {
    expect(isValidWindowKey(key(-1), NOW)).toBe(false);
    expect(isValidWindowKey(key(HORIZON_DAYS + 1), NOW)).toBe(false);
    expect(isValidWindowKey('2026-07-20:night', NOW)).toBe(false);
    expect(isValidWindowKey('2026-02-31:morning', NOW)).toBe(false);
    expect(isValidWindowKey('garbage', NOW)).toBe(false);
  });
});

describe('windowLabel', () => {
  it('renders a human label', () => {
    expect(windowLabel('2026-07-22:evening')).toBe('Wed 22 Jul, evening');
  });
});

describe('getScheduling', () => {
  it('splits mine/theirs and computes the overlap', async () => {
    armConv([
      { user_id: 'u-a', window_key: key(1) },
      { user_id: 'u-a', window_key: key(2, 'evening') },
      { user_id: 'u-b', window_key: key(2, 'evening') },
      { user_id: 'u-b', window_key: key(3) },
    ]);
    const s = await getScheduling('conv-1', 'u-a');
    expect(s.partnerId).toBe('u-b');
    expect(s.mine).toEqual([key(1), key(2, 'evening')].sort());
    expect(s.theirs).toEqual([key(2, 'evening'), key(3)].sort());
    expect(s.overlap).toEqual([key(2, 'evening')]);
    expect(s.confirmed).toBeNull();
  });

  it('a stranger to the conversation is rejected', async () => {
    armConv([]);
    await expect(getScheduling('conv-1', 'u-intruder')).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── Availability-change dot (W-meet, 8 Sep 2026) ─────────────────────────────
describe('schedulingUpdated dot', () => {
  const older = new Date('2026-09-07T10:00:00Z');
  const newer = new Date('2026-09-07T11:00:00Z');

  it('is TRUE for me when the partner changed availability since I last looked', async () => {
    // I am side A. Partner (B) updated at `newer`; I last opened at `older`.
    armConv([], { ...CONV, avail_updated_at_b: newer, scheduler_seen_at_a: older });
    const s = await getScheduling('conv-1', 'u-a');
    expect(s.schedulingUpdated).toBe(true);
  });

  it('is FALSE once I have opened the scheduler more recently than their change', async () => {
    armConv([], { ...CONV, avail_updated_at_b: older, scheduler_seen_at_a: newer });
    const s = await getScheduling('conv-1', 'u-a');
    expect(s.schedulingUpdated).toBe(false);
  });

  it('is TRUE when the partner changed and I have never opened the scheduler', async () => {
    armConv([], { ...CONV, avail_updated_at_b: newer, scheduler_seen_at_a: null });
    const s = await getScheduling('conv-1', 'u-a');
    expect(s.schedulingUpdated).toBe(true);
  });

  it('does not fire from MY OWN change (only the partner\'s counts)', async () => {
    // I am side A and only A has an update stamp — B (partner) never changed.
    armConv([], { ...CONV, avail_updated_at_a: newer, scheduler_seen_at_a: null });
    const s = await getScheduling('conv-1', 'u-a');
    expect(s.schedulingUpdated).toBe(false);
  });
});

// ── Concrete 30-minute slots (Stefan, 9 Sep 2026) ────────────────────────────
describe('time slots (UTC instants)', () => {
  const slotAt = (daysAhead: number, hh: number, mm: number) => {
    const d = new Date(NOW.getTime() + daysAhead * 86_400_000);
    d.setUTCHours(hh, mm, 0, 0);
    return d.toISOString().replace('.000Z', 'Z');
  };

  it('accepts a 30-minute-aligned slot from now up to the horizon', () => {
    expect(isValidWindowKey(slotAt(1, 13, 30), NOW)).toBe(true);
    expect(isValidWindowKey(slotAt(1, 9, 0), NOW)).toBe(true);
    expect(isValidWindowKey(slotAt(HORIZON_DAYS, 9, 0), NOW)).toBe(true);
  });
  it('rejects off-grid minutes, the past beyond one slot of grace, and beyond the horizon', () => {
    expect(isValidWindowKey(slotAt(1, 13, 15), NOW)).toBe(false);
    expect(isValidWindowKey(slotAt(-1, 13, 30), NOW)).toBe(false);
    expect(isValidWindowKey(slotAt(HORIZON_DAYS + 2, 9, 0), NOW)).toBe(false);
    expect(isValidWindowKey('2026-07-20T13:30:00', NOW)).toBe(false); // no Z
  });
  it("labels a slot in the reader's timezone, UTC when unknown or invalid", () => {
    expect(windowLabel('2026-07-22T13:30:00Z', 'Europe/Berlin')).toBe('Wed 22 Jul, 15:30 CEST');
    expect(windowLabel('2026-07-22T13:30:00Z', 'Asia/Karachi')).toMatch(/^Wed 22 Jul, 18:30 (PKT|GMT\+5)$/);
    expect(windowLabel('2026-07-22T13:30:00Z')).toBe('Wed 22 Jul, 13:30 UTC');
    expect(windowLabel('2026-07-22T13:30:00Z', 'Mars/Olympus')).toBe('Wed 22 Jul, 13:30 UTC');
  });
  it('confirming a slot uses the slot itself as the start time, with a custom length', async () => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); d.setUTCHours(13, 30, 0, 0);
    const SLOT = d.toISOString().replace('.000Z', 'Z');
    armConv([{ user_id: 'u-a', window_key: SLOT }, { user_id: 'u-b', window_key: SLOT }]);
    await confirmWindow('conv-1', 'u-a', SLOT, { durationMin: 20, type: 'audio' });
    const upd = mockQuery.mock.calls.find(c => /UPDATE dm_conversations\s+SET meeting_confirmed_window/.test(c[0] as string))!;
    const params = upd[1] as unknown[];
    expect((params[3] as Date).toISOString()).toBe(d.toISOString()); // startAt = the slot
    expect(params[4]).toBe(20);                                       // custom minutes
    expect(params[5]).toBe('audio');
    // Shared thread line embeds the instant (each client localises it) + the
    // length, and carries the meta the card draws itself from.
    expect(cardContent()).toBe(`📅 Meeting confirmed: ${SLOT} · 20 min audio call`);
    expect(cardMeta()).toMatchObject({ type: 'meeting_confirmed', durationMin: 20, meetingType: 'audio' });
    // The partner's bell is in THEIR timezone (Berlin), not UTC. The type is a
    // bound parameter now, so the body sits at index 3: [user, type, title, body, link].
    const bell = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect((bell[1] as unknown[])[1]).toBe('meeting_confirmed');
    expect((bell[1] as unknown[])[3]).toMatch(/^\w{3} \d{1,2} \w{3}, \d{2}:\d{2} (CEST|CET|GMT\+[12]) · 20 min audio call$/);
  });
  it('a custom length as short as 5 minutes is allowed', async () => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); d.setUTCHours(9, 0, 0, 0);
    const SLOT = d.toISOString().replace('.000Z', 'Z');
    armConv([{ user_id: 'u-a', window_key: SLOT }, { user_id: 'u-b', window_key: SLOT }]);
    await confirmWindow('conv-1', 'u-a', SLOT, { durationMin: 5, type: 'video' });
    const upd = mockQuery.mock.calls.find(c => /UPDATE dm_conversations\s+SET meeting_confirmed_window/.test(c[0] as string))!;
    expect((upd[1] as unknown[])[4]).toBe(5);
  });
  it('legacy day-part keys still validate and confirm (existing rows keep working)', () => {
    expect(isValidWindowKey(key(2, 'evening'), NOW)).toBe(true);
    expect(windowLabel('2026-07-22:evening')).toBe('Wed 22 Jul, evening');
  });
});

describe('markSchedulerSeen', () => {
  it('stamps side A\'s seen column for user_a', async () => {
    armConv([]);
    await markSchedulerSeen('conv-1', 'u-a');
    const upd = mockQuery.mock.calls.find(c => /UPDATE dm_conversations SET scheduler_seen_at_a/.test(c[0] as string));
    expect(upd).toBeTruthy();
  });
  it('stamps side B\'s seen column for user_b', async () => {
    armConv([]);
    await markSchedulerSeen('conv-1', 'u-b');
    const upd = mockQuery.mock.calls.find(c => /UPDATE dm_conversations SET scheduler_seen_at_b/.test(c[0] as string));
    expect(upd).toBeTruthy();
  });
});

describe('setAvailability', () => {
  it('replaces my selection: DELETE mine, then ONE insert for all of them', async () => {
    armConv([]);
    await setAvailability('conv-1', 'u-a', [futureKey(1), futureKey(2, 'evening')]);
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /DELETE FROM meeting_availability/.test(s))).toBe(true);
    // One statement for the whole set, not one per time (a week of 30-minute
    // slots used to be 200 round trips inside the transaction).
    const inserts = sqls.filter(s => /INSERT INTO meeting_availability/.test(s));
    expect(inserts.length).toBe(1);
    expect(inserts[0]).toMatch(/unnest/);
  });

  it('rejects a window beyond the horizon with a 400', async () => {
    armConv([]);
    await expect(setAvailability('conv-1', 'u-a', [futureKey(HORIZON_DAYS + 5)]))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  // 19 Sep, latent: the client re-sends every saved time on each save and
  // cannot untick one that has passed, so rejecting the payload meant that the
  // morning after you first saved, saving failed for good.
  it('DROPS times that have already passed instead of failing the whole save', async () => {
    armConv([]);
    const good = futureKey(2);
    await expect(setAvailability('conv-1', 'u-a', [futureKey(-3), good])).resolves.toBeTruthy();
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO meeting_availability/.test(c[0] as string))!;
    expect((insert[1] as unknown[])[2]).toEqual([good]);
  });

  it('stamps MY availability-changed time so the partner\'s dot can fire', async () => {
    armConv([]);
    await setAvailability('conv-1', 'u-a', [futureKey(1)]);
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /UPDATE dm_conversations SET avail_updated_at_a = NOW\(\)/.test(s))).toBe(true);
  });

  it('tells the other person the first time I share anything', async () => {
    armSave([], [{ user_id: 'u-a', window_key: futureKey(1) }]); // nobody had anything
    await setAvailability('conv-1', 'u-a', [futureKey(1)]);
    expect(mockInsertOn).toHaveBeenCalledTimes(1);
    expect(cardContent()).toMatch(/shared times they can meet/);
    expect(cardMeta()).toMatchObject({ type: 'availability_shared' });
  });

  it('says nothing on a later save that changes no overlap', async () => {
    // I already have times saved, so this is not my first share.
    armConv([{ user_id: 'u-a', window_key: futureKey(1) }], { ...CONV, avail_shared_at_a: new Date() });
    await setAvailability('conv-1', 'u-a', [futureKey(1), futureKey(2)]);
    expect(mockInsertOn).not.toHaveBeenCalled();
  });

  // The second person to save is the one who creates the overlap, and before
  // this nobody was told: "we both have saved our availability?" / "no clue!!!"
  it('posts ONE proposal card the moment both sides can meet', async () => {
    const shared = futureKey(2, 'evening');
    // Partner already saved it; my save is what makes it an overlap.
    armSave(
      [{ user_id: 'u-b', window_key: shared }],
      [{ user_id: 'u-b', window_key: shared }, { user_id: 'u-a', window_key: shared }],
    );
    await setAvailability('conv-1', 'u-a', [shared]);
    expect(mockInsertOn).toHaveBeenCalledTimes(1);
    expect(cardContent()).toMatch(/You are both free/);
    expect(cardMeta()).toMatchObject({ type: 'meeting_proposal', slots: [shared] });
    // …and the partner is rung, with a link to this thread, not just /messages.
    const bell = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect(bell[0]).toMatch(/\$2/);
    expect((bell[1] as unknown[])[1]).toBe('meeting_proposed');
    expect((bell[1] as unknown[])[4]).toBe('/messages/conv-1');
  });

  it('does not post a second proposal when the same overlap is re-saved', async () => {
    const shared = futureKey(2, 'evening');
    // Both already have it: the overlap did not just come into existence.
    armConv(
      [{ user_id: 'u-a', window_key: shared }, { user_id: 'u-b', window_key: shared }],
      { ...CONV, meeting_proposed_key: shared, meeting_proposed_at: new Date() },
    );
    await setAvailability('conv-1', 'u-a', [shared, futureKey(3)]);
    expect(mockInsertOn).not.toHaveBeenCalled();
  });

  it('says nothing once a meeting is already set', async () => {
    const shared = futureKey(2, 'evening');
    armSave(
      [{ user_id: 'u-b', window_key: shared }],
      [{ user_id: 'u-b', window_key: shared }, { user_id: 'u-a', window_key: shared }],
      { ...CONV, meeting_confirmed_window: shared },
    );
    await setAvailability('conv-1', 'u-a', [shared]);
    expect(mockInsertOn).not.toHaveBeenCalled();
  });

  it('refuses to schedule with someone a block stands between', async () => {
    armConv([]);
    mockAreBlocked.mockResolvedValue(true);
    await expect(setAvailability('conv-1', 'u-a', [futureKey(1)]))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mockInsertOn).not.toHaveBeenCalled();
  });
});

describe('confirmWindow', () => {
  it('rejects a window only ONE side selected', async () => {
    const windowKey = futureKey(2);
    armConv([{ user_id: 'u-a', window_key: windowKey }]); // partner never picked it
    await expect(confirmWindow('conv-1', 'u-a', windowKey))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('confirms an overlap window: updates the conversation, drops a thread message, notifies the partner', async () => {
    const windowKey = futureKey(2, 'evening');
    armConv([
      { user_id: 'u-a', window_key: windowKey },
      { user_id: 'u-b', window_key: windowKey },
    ]);
    mockBroadcastDm.mockClear();

    await confirmWindow('conv-1', 'u-a', windowKey);

    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /UPDATE dm_conversations\s+SET meeting_confirmed_window/.test(s))).toBe(true);
    // The card is written by the confirmer, inside the same transaction.
    expect(mockInsertOn).toHaveBeenCalledTimes(1);
    const call = mockInsertOn.mock.calls[0] as unknown[];
    expect(call[1]).toBe('u-a');
    expect(call[2]).toBe('u-b');
    expect(call[3]).toMatch(/Meeting confirmed/);
    expect((call[5] as { kind: string }).kind).toBe('system');
    // …and it is fanned out to both inboxes/threads in real time (notify:false —
    // the meeting_confirmed bell below covers the notification).
    expect(mockBroadcastDm).toHaveBeenCalledTimes(1);
    const bcall = mockBroadcastDm.mock.calls[0] as unknown[];
    expect(bcall[1]).toBe('u-a');
    expect(bcall[2]).toBe('u-b');
    expect(bcall[3]).toBe('conv-1');
    expect(bcall[5]).toMatchObject({ notify: false });
    // Bell notification for the partner, linking to THIS thread.
    const notif = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect((notif[1] as unknown[])[0]).toBe('u-b');
    expect((notif[1] as unknown[])[1]).toBe('meeting_confirmed');
    expect((notif[1] as unknown[])[4]).toBe('/messages/conv-1');
  });

  it('an exact time is stored and emailed to both people as a calendar invite (W6)', async () => {
    const windowKey = futureKey(3, 'afternoon');
    const day = windowKey.split(':')[0];
    const startAt = new Date(`${day}T14:00:00Z`).toISOString();
    // Answer the users lookup with two real emails; everything else as before.
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [CONV] });
      if (/FROM meeting_availability/.test(sql)) return Promise.resolve({ rows: [
        { user_id: 'u-a', window_key: windowKey }, { user_id: 'u-b', window_key: windowKey },
      ] });
      if (/FROM users WHERE id = ANY/.test(sql)) return Promise.resolve({ rows: [
        { id: 'u-a', display_name: 'Ana', email: 'ana@example.com', timezone: 'Europe/Berlin' },
        { id: 'u-b', display_name: 'Bo', email: 'bo@example.com', timezone: 'America/New_York' },
      ] });
      return Promise.resolve({ rows: [{ id: 'n1', created_at: NOW }] });
    });
    mockSendMtgEmail.mockClear();

    await confirmWindow('conv-1', 'u-a', windowKey, { startAt, durationMin: 45 });

    const upd = mockQuery.mock.calls.find(c => /UPDATE dm_conversations\s+SET meeting_confirmed_window/.test(c[0] as string))!;
    expect(String(upd[0])).toMatch(/meeting_start_at = \$4, meeting_duration_min = \$5/);
    expect((upd[1] as unknown[])[3]).toBeInstanceOf(Date);       // startAt
    expect((upd[1] as unknown[])[4]).toBe(45);                    // durationMin
    // Both people get the invite, each with their own timezone.
    expect(mockSendMtgEmail).toHaveBeenCalledTimes(2);
    const recipients = mockSendMtgEmail.mock.calls.map(c => c[0]).sort();
    expect(recipients).toEqual(['ana@example.com', 'bo@example.com']);
  });

  it('rejects an exact time in the past', async () => {
    const windowKey = futureKey(3, 'afternoon');
    armConv([
      { user_id: 'u-a', window_key: windowKey }, { user_id: 'u-b', window_key: windowKey },
    ]);
    await expect(confirmWindow('conv-1', 'u-a', windowKey, { startAt: '2020-01-01T10:00:00Z', durationMin: 30 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  // Replaces "a failed thread message does not lose the confirmation itself".
  // That was the old shape: the meeting was saved and the card was best-effort,
  // so a meeting could exist that neither person was ever told about. They now
  // land together or not at all.
  it('a meeting is never stored without the card that announces it', async () => {
    const windowKey = futureKey(2);
    armConv([
      { user_id: 'u-a', window_key: windowKey },
      { user_id: 'u-b', window_key: windowKey },
    ]);
    mockInsertOn.mockRejectedValue(new Error('dm down'));
    await expect(confirmWindow('conv-1', 'u-a', windowKey)).rejects.toThrow('dm down');
  });

  it('pressing Confirm twice books ONE meeting, with no second card, bell or email', async () => {
    const windowKey = futureKey(2, 'evening');
    // Second press: the row already carries this very window.
    armConv(
      [{ user_id: 'u-a', window_key: windowKey }, { user_id: 'u-b', window_key: windowKey }],
      { ...CONV, meeting_confirmed_window: windowKey, meeting_start_at: null, meeting_duration_min: null },
    );
    mockSendMtgEmail.mockClear();
    const res = await confirmWindow('conv-1', 'u-a', windowKey);
    expect(res.confirmed?.window).toBe(windowKey);
    expect(mockInsertOn).not.toHaveBeenCalled();
    expect(mockSendMtgEmail).not.toHaveBeenCalled();
    const sqls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(sqls.some(s => /UPDATE dm_conversations\s+SET meeting_confirmed_window/.test(s))).toBe(false);
  });

  it('refuses a DIFFERENT time while a meeting still stands, and says which', async () => {
    const standing = futureKey(2, 'evening');
    const other = futureKey(3, 'morning');
    const start = new Date(Date.now() + 2 * 86_400_000);
    armConv(
      [{ user_id: 'u-a', window_key: other }, { user_id: 'u-b', window_key: other }],
      { ...CONV, meeting_confirmed_window: standing, meeting_start_at: start, meeting_duration_min: 30 },
    );
    await expect(confirmWindow('conv-1', 'u-a', other)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockInsertOn).not.toHaveBeenCalled();
  });

  it('lets them pick again once the earlier meeting is over', async () => {
    const stale = futureKey(1);
    const next = futureKey(3, 'morning');
    const longGone = new Date(Date.now() - 4 * 3_600_000);
    armConv(
      [{ user_id: 'u-a', window_key: next }, { user_id: 'u-b', window_key: next }],
      { ...CONV, meeting_confirmed_window: stale, meeting_start_at: longGone, meeting_duration_min: 30 },
    );
    await expect(confirmWindow('conv-1', 'u-a', next)).resolves.toBeTruthy();
    expect(mockInsertOn).toHaveBeenCalledTimes(1);
  });

  it('refuses to confirm with someone a block stands between', async () => {
    const windowKey = futureKey(2);
    armConv([
      { user_id: 'u-a', window_key: windowKey }, { user_id: 'u-b', window_key: windowKey },
    ]);
    mockAreBlocked.mockResolvedValue(true);
    await expect(confirmWindow('conv-1', 'u-a', windowKey)).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ── The calendar file's identity (21 Sep 2026) ───────────────────────────────
describe('meetingUid', () => {
  it('is the same for the same meeting, and different for a different time', () => {
    const t1 = new Date('2026-09-24T13:00:00Z');
    const t2 = new Date('2026-09-24T14:00:00Z');
    expect(meetingUid('conv-1', t1)).toBe(meetingUid('conv-1', t1));
    expect(meetingUid('conv-1', t1)).not.toBe(meetingUid('conv-1', t2));
    expect(meetingUid('conv-1', t1)).not.toBe(meetingUid('conv-2', t1));
  });
});

describe('isMeetingOver', () => {
  it('stands until 30 minutes after it should have ended', () => {
    const start = new Date('2026-09-24T13:00:00Z');
    expect(isMeetingOver(start, 30, new Date('2026-09-24T13:45:00Z'))).toBe(false);
    expect(isMeetingOver(start, 30, new Date('2026-09-24T14:01:00Z'))).toBe(true);
    expect(isMeetingOver(null, 30, new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('isPastKey', () => {
  it('knows a slot by its instant and a daypart by the end of its day', () => {
    expect(isPastKey('2026-09-24T13:00:00Z', new Date('2026-09-24T14:00:00Z'))).toBe(true);
    expect(isPastKey('2026-09-24T13:00:00Z', new Date('2026-09-24T12:00:00Z'))).toBe(false);
    expect(isPastKey('2026-09-24:evening', new Date('2026-09-25T13:00:00Z'))).toBe(true);
    expect(isPastKey('2026-09-24:evening', new Date('2026-09-24T23:00:00Z'))).toBe(false);
  });
});

// ── acceptPoke seeds the introduction into the new thread ────────────────────
// (REASON Phase 2 — "we introduce them to each other". The poke's message
// becomes the first DM instead of dying with the accepted poke.)

describe('acceptPoke intro seeding', () => {
  // block.service is mocked ONCE at the top of this file (mockAreBlocked).
  // A second jest.mock for the same path here would be hoisted above it and
  // silently win, which is what made the scheduling block tests pass by
  // accident: they were asserting against this always-false stub.

  function armAccept(message: string | null) {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM user_pokes WHERE id/.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 'poke-1', sender_id: 'u-send', recipient_id: 'u-recv',
            status: 'pending', message, responded_at: null, created_at: new Date(),
          }],
        });
      }
      if (/UPDATE user_pokes/.test(sql)) return Promise.resolve({ rows: [{ responded_at: new Date() }] });
      if (/INSERT INTO dm_conversations/.test(sql)) return Promise.resolve({ rows: [{ id: 'conv-9' }] });
      if (/SELECT display_name FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ display_name: 'Recv Person' }] });
      if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'notif-1', created_at: new Date() }] });
      if (/INSERT INTO direct_messages/.test(sql)) return Promise.resolve({ rows: [{
        id: 'dm-1', conversation_id: 'conv-9', from_user_id: 'u-send',
        content: message ?? "You're connected. Say hello.", read_at: null, created_at: new Date(),
        attachment_url: null, attachment_type: null, attachment_meta: null,
      }] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('a poke WITH a message seeds it as the first thread message from the sender', async () => {
    const pokeService = await import('../../../services/poke/poke.service');
    armAccept('You fit what they want. We think you two should meet.');
    await pokeService.acceptPoke('poke-1', 'u-recv');
    const dmInsert = mockQuery.mock.calls.find(c => /INSERT INTO direct_messages/.test(c[0] as string));
    expect(dmInsert).toBeTruthy(); // the intro must land in the thread
    const params = dmInsert![1] as string[];
    expect(params[1]).toBe('conv-9');            // conversation
    expect(params[2]).toBe('u-send');            // authored by the sender
    expect(params[3]).toMatch(/should meet/);
  });

  // Task F3 (23 Jul 2026) — a message-less poke used to seed nothing, leaving
  // a 0-message conversation canMessage()'s grandfather clause could never
  // open. It now seeds a fallback line instead, sender-authored, so the
  // thread is always usable. Full coverage of this edge lives in
  // __tests__/services/poke/poke.service.test.ts; this pin just confirms
  // the old "seeds nothing" behavior is gone.
  it('a message-less poke seeds the fallback intro instead of nothing', async () => {
    const pokeService = await import('../../../services/poke/poke.service');
    armAccept(null);
    await pokeService.acceptPoke('poke-1', 'u-recv');
    const dmInsert = mockQuery.mock.calls.find(c => /INSERT INTO direct_messages/.test(c[0] as string));
    expect(dmInsert).toBeTruthy();
    const params = dmInsert![1] as string[];
    expect(params[2]).toBe('u-send');
    expect(params[3]).toBe("You're connected. Say hello.");
  });
});
