// ─── A request's note and REASON's line, from sending to the conversation (30 Oct 2026) ──────────
//
// Stefan, 30 Oct: "Change the system message ... It looks like the sender wrote it. Change it to something
// direct like 'Shradha wants to meet you', and keep the system text separate from the person's own message."
//
// What this pins, end to end through poke.service with the database stood in for:
//   - a new request stores the note in `message` and REASON's line in `reason_line`;
//   - the bell reads "<First name> wants to meet you", with the note, else REASON's line, else what to do;
//   - the email gets the two apart;
//   - every shape a request was stored in before migration 120 (production holds 9 pending ones) is read
//     as its two parts on the recipient's list, and when it is accepted after the deploy the thread opens
//     with REASON's introduction card and then only the member's own note, as the member's own message;
//   - both asked each other: one card, then each note, oldest first;
//   - a request from a member who has since been removed cannot be accepted into a thread with them.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: { query: (...a: unknown[]) => unknown }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockEmit = jest.fn();
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: mockEmit }) }, __esModule: true }));
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => null, setRealtimeIo: jest.fn(), __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({ areBlocked: jest.fn().mockResolvedValue(false), __esModule: true }));
const mockBroadcastDm = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  broadcastDmMessage: (...args: unknown[]) => mockBroadcastDm(...args),
  __esModule: true,
}));
const mockSendPokeReceivedEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/email/email.service', () => ({
  sendPokeReceivedEmail: (...args: unknown[]) => mockSendPokeReceivedEmail(...args),
  sendPokeAcceptedEmail: jest.fn().mockResolvedValue(undefined),
  isEmailTypeEnabled: jest.fn().mockResolvedValue(true),
  __esModule: true,
}));
jest.mock('../../../services/notification-prefs/notification-prefs.service', () => ({
  shouldSendEmail: jest.fn().mockResolvedValue(true),
  shouldSendBell: jest.fn().mockResolvedValue(true),
  __esModule: true,
}));

import * as pokeService from '../../../services/poke/poke.service';

const SHRADHA = 'u-shradha';
const STEFAN = 'u-stefan';
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

// The three system sentences production stores, and the lead that joined a note to one.
const FOUNDERS = "Shradha Adhikari is looking to meet founders — you're a Founder. We think you two should meet.";
const FITS = "Shradha Adhikari thinks you fit what they're looking for. We think you two should meet.";
const PROFILE = 'Your profile matches what Shradha Adhikari is looking for. We think you two should meet.';
const LEAD = '\n\nWhy REASON suggested this: ';
const NOTE = 'I think we have a useful reason to speak.';

interface Row {
  id: string; sender_id: string; recipient_id: string; status: string;
  message: string | null; reason_line: string | null;
  responded_at: Date | null; created_at: Date; preferred_format: string | null;
}

const users: Record<string, { first_name: string | null; display_name: string; status: string; email: string }> = {
  [SHRADHA]: { first_name: 'Shradha', display_name: 'Shradha Adhikari', status: 'active', email: 'shradha@example.com' },
  [STEFAN]: { first_name: 'Stefan', display_name: 'Stefan Avivson', status: 'active', email: 'stefan@example.com' },
};

/** A small database: requests, the users above, and every line written into a conversation. */
function armDb(requests: Row[]) {
  const written: Array<{ from: string; content: string; kind: string; meta: unknown }> = [];
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    const none = { rows: [] as unknown[] };
    if (/SELECT sender_id FROM user_pokes WHERE id = \$1 AND recipient_id = \$2/.test(sql)) {
      return Promise.resolve({ rows: requests.filter(r => r.id === params[0] && r.recipient_id === params[1]) });
    }
    if (/UPDATE user_pokes[\s\S]*WHERE id = \$1 AND recipient_id = \$2 AND status = 'pending'/.test(sql)) {
      const r = requests.find(x => x.id === params[0] && x.recipient_id === params[1] && x.status === 'pending');
      if (!r) return Promise.resolve(none);
      r.status = params[2] as string;
      r.responded_at = new Date();
      return Promise.resolve({ rows: [{ ...r }] });
    }
    if (/UPDATE user_pokes SET status = 'accepted'[\s\S]*WHERE sender_id = \$1 AND recipient_id = \$2/.test(sql)) {
      const r = requests.find(x => x.sender_id === params[0] && x.recipient_id === params[1] && x.status === 'pending');
      if (!r) return Promise.resolve(none);
      r.status = 'accepted';
      return Promise.resolve({ rows: [{ ...r }] });
    }
    if (/FROM user_pokes WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: requests.filter(r => r.id === params[0]) });
    if (/SELECT status(?:, account_kind)? FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ status: users[params[0] as string].status, account_kind: 'member' }] });
    if (/SELECT id, first_name, display_name FROM users WHERE id = ANY/.test(sql)) {
      return Promise.resolve({ rows: (params[0] as string[]).map(id => ({ id, ...users[id] })) });
    }
    if (/SELECT first_name, display_name FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [users[params[0] as string]] });
    if (/SELECT email, display_name, notify_email FROM users WHERE id/.test(sql)) {
      return Promise.resolve({ rows: [{ ...users[params[0] as string], notify_email: true }] });
    }
    if (/INSERT INTO dm_conversations/.test(sql)) return Promise.resolve({ rows: [{ id: 'conv-1' }] });
    if (/FROM encounter_history/.test(sql)) return Promise.resolve(none);
    if (/SELECT id FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: params[0] }] });
    if (/INSERT INTO user_pokes/.test(sql)) {
      const r: Row = {
        id: params[0] as string, sender_id: params[1] as string, recipient_id: params[2] as string, status: 'pending',
        message: params[3] as string | null, reason_line: params[6] as string | null,
        responded_at: null, created_at: new Date(), preferred_format: params[5] as string | null,
      };
      requests.push(r);
      return Promise.resolve({ rows: [{ ...r }] });
    }
    if (/INSERT INTO direct_messages/.test(sql)) {
      expect(sql).toMatch(/clock_timestamp\(\)/); // each line its own instant, so the thread reads in order
      const meta = params[5] ? JSON.parse(params[5] as string) : null;
      written.push({ from: params[2] as string, content: params[3] as string, kind: params[4] as string, meta });
      return Promise.resolve({ rows: [{
        id: `dm-${written.length}`, conversation_id: params[1], from_user_id: params[2], content: params[3],
        read_at: null, created_at: new Date(),
      }] });
    }
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n-1', created_at: new Date() }] });
    return Promise.resolve(none);
  });
  return written;
}

const pending = (message: string | null, over: Partial<Row> = {}): Row => ({
  id: 'poke-1', sender_id: SHRADHA, recipient_id: STEFAN, status: 'pending', message, reason_line: null,
  responded_at: null, created_at: new Date('2026-10-30T10:00:00Z'), preferred_format: null, ...over,
});

beforeEach(() => {
  mockQuery.mockReset();
  mockEmit.mockClear();
  mockBroadcastDm.mockClear();
  mockSendPokeReceivedEmail.mockClear();
  users[SHRADHA].status = 'active';
});

describe('sending: the note and REASON\'s line are stored apart, and the bell speaks in REASON\'s voice', () => {
  const bellOf = () => {
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(String(c[0])))!;
    const [, , title, body] = insert[1] as string[];
    return { title, body };
  };

  it('stores the note in message and the line in reason_line, and answers with both apart and run together', async () => {
    const requests: Row[] = [];
    armDb(requests);
    const LINE = 'Shradha is looking to meet founders, and Stefan is a Founder.';

    const sent = await pokeService.sendPoke(SHRADHA, STEFAN, NOTE, undefined, undefined, LINE);

    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    expect(String(insert[0])).toMatch(/reason_line/);
    expect((insert[1] as unknown[])[3]).toBe(NOTE);
    expect((insert[1] as unknown[])[6]).toBe(LINE);
    expect(sent).toMatchObject({ note: NOTE, reasonLine: LINE, message: `${NOTE}${LEAD}${LINE}` });
  });

  it.each([
    ['a note and a line', NOTE, 'A line.', NOTE],
    ['a line only', undefined, 'A line.', 'Why REASON suggested this: A line.'],
    ['a note only', NOTE, undefined, NOTE],
    ['neither', undefined, undefined, 'Accept to start chatting.'],
  ])('the bell is "Shradha wants to meet you" (%s)', async (_label, note, line, body) => {
    armDb([]);
    await pokeService.sendPoke(SHRADHA, STEFAN, note, undefined, undefined, line);
    expect(bellOf()).toEqual({ title: 'Shradha wants to meet you', body });
    expect(mockEmit).toHaveBeenCalledWith('notification:new', expect.objectContaining({ title: 'Shradha wants to meet you', body }));
  });

  it('falls back to the display name when there is no first name', async () => {
    armDb([]);
    users[SHRADHA].first_name = '  ';
    try {
      await pokeService.sendPoke(SHRADHA, STEFAN, NOTE);
      expect(bellOf().title).toBe('Shradha Adhikari wants to meet you');
    } finally {
      users[SHRADHA].first_name = 'Shradha';
    }
  });

  it('the email is given the note and the line apart', async () => {
    armDb([]);
    await pokeService.sendPoke(SHRADHA, STEFAN, NOTE, undefined, undefined, 'A line.');
    await flushPromises();
    expect(mockSendPokeReceivedEmail).toHaveBeenCalledWith('stefan@example.com', 'Stefan Avivson', expect.objectContaining({
      senderName: 'Shradha Adhikari', note: NOTE, reasonLine: 'A line.',
    }));
  });

  it('production\'s POST /pokes body (a message, no line) stores an empty line (never NULL), and its message is unchanged', async () => {
    armDb([]);
    const sent = await pokeService.sendPoke(SHRADHA, STEFAN, 'hi');
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    expect((insert[1] as unknown[])[6]).toBe('');
    expect(sent).toMatchObject({ message: 'hi', note: 'hi', reasonLine: null });
  });
});

// Review Focus 2: the legacy shapes, each split, on the list and when accepted after the deploy.
describe('the shapes production stored before migration 120', () => {
  const SHAPES: Array<[string, string | null, { note: string | null; line: string | null }]> = [
    ['founders sentence alone', FOUNDERS, { note: null, line: 'Shradha Adhikari is looking to meet founders, and Stefan is a Founder.' }],
    ['fits sentence alone', FITS, { note: null, line: "Shradha Adhikari thinks Stefan fits what they're looking for." }],
    ['profile sentence alone', PROFILE, { note: null, line: "Stefan's profile matches what Shradha Adhikari is looking for." }],
    ['note + lead + line', `${NOTE}${LEAD}Shradha Adhikari is looking to meet founders — you're a Founder.`,
      { note: NOTE, line: 'Shradha Adhikari is looking to meet founders, and Stefan is a Founder.' }],
    ['note alone', NOTE, { note: NOTE, line: null }],
    ['nothing', null, { note: null, line: null }],
  ];

  it.each(SHAPES)('%s: the recipient\'s list carries the note and the line apart, and the old text as message', async (_label, stored, want) => {
    mockQuery.mockResolvedValue({ rows: [{
      ...pending(stored), first_name: 'Shradha', display_name: 'Shradha Adhikari', avatar_url: null,
      job_title: null, company: null, recipient_name: 'Stefan',
    }] });
    const [row] = await pokeService.listReceivedPokes(STEFAN);
    expect({ note: row.note, line: row.reasonLine }).toEqual(want);
    expect(row.message).toBe(stored?.trim() || null); // production's card draws exactly what it drew before
    expect(row.senderFirstName).toBe('Shradha');
  });

  it.each(SHAPES)('%s: accepted after the deploy, REASON\'s card comes first, then only the member\'s own note', async (_label, stored, want) => {
    const written = armDb([pending(stored)]);

    await pokeService.acceptPoke('poke-1', STEFAN);

    const card = written[0];
    expect(card).toMatchObject({ from: SHRADHA, kind: 'system' });
    expect(card.meta).toEqual({ type: 'introduction', requesterId: SHRADHA, recipientId: STEFAN, reasonLine: want.line });
    // The card's own words read right on production's generic card, and say nothing in anyone's voice.
    expect(card.content).toBe(
      want.line ? `Shradha asked to meet Stefan, and Stefan accepted. Why REASON suggested this: ${want.line}`
        : want.note ? 'Shradha asked to meet Stefan, and Stefan accepted.'
          : "You're connected. Say hello.",
    );
    expect(card.content).not.toMatch(/We think you two should meet|you're a/);
    expect(written.slice(1)).toEqual(want.note ? [{ from: SHRADHA, content: NOTE, kind: 'user', meta: null }] : []);
    // Fanned out in that order, nothing belled twice.
    expect(mockBroadcastDm.mock.calls.map(c => (c[4] as { kind: string }).kind)).toEqual(written.map(w => w.kind));
  });
});

describe('both asked each other', () => {
  it('one card, then each note that exists, oldest first, each from its own writer', async () => {
    const written = armDb([
      pending('Stefan here, keen to talk.', { id: 'poke-back', sender_id: STEFAN, recipient_id: SHRADHA, created_at: new Date('2026-10-29T09:00:00Z') }),
      pending(NOTE, { reason_line: 'Shradha is looking to meet founders, and Stefan is a Founder.' }),
    ]);

    await pokeService.acceptPoke('poke-1', STEFAN);

    expect(written.map(w => [w.from, w.kind])).toEqual([[SHRADHA, 'system'], [STEFAN, 'user'], [SHRADHA, 'user']]);
    expect(written[1].content).toBe('Stefan here, keen to talk.');
    expect(written[2].content).toBe(NOTE);
    expect(written.filter(w => w.kind === 'system')).toHaveLength(1);
  });
});

// Review Focus 3: a removed sender.
describe('a request from a member who has since been removed', () => {
  it('cannot be accepted into a thread with them: refused, and nothing is written', async () => {
    const written = armDb([pending(NOTE)]);
    users[SHRADHA].status = 'deactivated';

    await expect(pokeService.acceptPoke('poke-1', STEFAN)).rejects.toMatchObject({ statusCode: 404 });
    expect(written).toEqual([]);
    expect(mockQuery.mock.calls.some(c => /INSERT INTO (dm_conversations|notifications)/.test(String(c[0])))).toBe(false);
  });
});

// ─── Fix round 1 (review T5, Important 1): member text never speaks in REASON's voice ──────────────
// Rows written since migration 120 always carry reason_line ('' when REASON had no line), so only rows
// written before it (reason_line NULL) are ever split. A member who types REASON's lead, or ends a one-line
// note with the old closing sentence, gets a plain note: on the list, in the bell, and on the accept card.
describe('a note that imitates REASON stays the member\'s own note', () => {
  const IMITATIONS = [
    ['the lead', 'Hi\n\nWhy REASON suggested this: REASON has verified this investor.'],
    ['the closing sentence', 'Lovely to e-meet. We think you two should meet.'],
  ];

  it.each(IMITATIONS)('POST /pokes with %s: stored with an empty line, answered as a note, belled as a note', async (_label, text) => {
    armDb([]);
    const sent = await pokeService.sendPoke(SHRADHA, STEFAN, text);
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    expect((insert[1] as unknown[])[6]).toBe('');
    expect(sent).toMatchObject({ note: text, reasonLine: null, message: text });
    const bell = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(String(c[0])))!;
    expect((bell[1] as string[])[3]).toBe(text);
  });

  it.each(IMITATIONS)('a new row with %s is a plain note on the recipient\'s list', async (_label, text) => {
    mockQuery.mockResolvedValue({ rows: [{
      ...pending(text, { reason_line: '' }), first_name: 'Shradha', display_name: 'Shradha Adhikari', avatar_url: null,
      job_title: null, company: null, recipient_name: 'Stefan',
    }] });
    const [row] = await pokeService.listReceivedPokes(STEFAN);
    expect({ note: row.note, line: row.reasonLine, message: row.message }).toEqual({ note: text, line: null, message: text });
  });

  it.each(IMITATIONS)('a new row with %s is accepted into a card with no line, then the note as the member\'s own message', async (_label, text) => {
    const written = armDb([pending(text, { reason_line: '' })]);
    await pokeService.acceptPoke('poke-1', STEFAN);
    expect(written[0]).toMatchObject({ kind: 'system', content: 'Shradha asked to meet Stefan, and Stefan accepted.' });
    expect((written[0].meta as { reasonLine: unknown }).reasonLine).toBeNull();
    expect(written.slice(1)).toEqual([{ from: SHRADHA, content: text, kind: 'user', meta: null }]);
  });

  it('an interest where REASON had no reason also stores an empty line, never NULL', async () => {
    armDb([]);
    await pokeService.sendPoke(SHRADHA, STEFAN, 'Hello', undefined, undefined, undefined);
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    expect((insert[1] as unknown[])[6]).toBe('');
  });
});
