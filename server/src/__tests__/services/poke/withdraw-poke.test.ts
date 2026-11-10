// server/src/__tests__/services/poke/withdraw-poke.test.ts
// 10 Nov 2026 (Stefan: "if I have ALREADY asked them, why is that not shown?"). Every place that offers "I want to
// meet" shows "Request sent" once it is pressed, with "Withdraw request" beside it. withdrawPoke takes a request
// back: only its sender, only while it waits. The request becomes 'cancelled', which every reader treats as no
// request at all: not "asked", not "connected", not a "no". The sender may ask again.
//
// The database is a small in-memory world of request rows, answering each statement the way Postgres would, so the
// tests read outcomes (the row's status, the bell row gone, a second request inserted) rather than SQL text alone.
// The SQL-shape guards at the bottom pin the readers that make "cancelled" mean "no request".

import * as fs from 'fs';
import * as path from 'path';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));
const mockEmitEntities = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({ areBlocked: async () => false, __esModule: true }));
jest.mock('../../../services/email/email.service', () => ({
  sendPokeReceivedEmail: jest.fn().mockResolvedValue(undefined),
  sendPokeAcceptedEmail: jest.fn().mockResolvedValue(undefined),
  isEmailTypeEnabled: jest.fn().mockResolvedValue(false),
  __esModule: true,
}));
jest.mock('../../../services/notification-prefs/notification-prefs.service', () => ({
  shouldSendEmail: jest.fn().mockResolvedValue(false),
  shouldSendBell: jest.fn().mockResolvedValue(true),
  __esModule: true,
}));

import { acceptPoke, getPokeState, getPokeWith, sendPoke, withdrawPoke } from '../../../services/poke/poke.service';
import { requestBellLink } from '../../../services/poke/request-link';
import { CONNECTION_SIGNALS_SQL } from '../../../services/people/connections.service';
import { notAlreadyInTouchSql } from '../../../services/matching/platform-match.service';

const A = '11111111-1111-4111-8111-111111111111'; // the sender
const B = '22222222-2222-4222-8222-222222222222'; // the recipient
const C = '33333333-3333-4333-8333-333333333333'; // someone else
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface Row {
  id: string; sender_id: string; recipient_id: string; status: string;
  message: string | null; reason_line: string | null; responded_at: Date | null; created_at: Date;
  preferred_format: null; cancelled_at: Date | null;
}
interface Bell { user_id: string; type: string; link: string; is_read: boolean }

let rows: Row[];
let bells: Bell[];
let clock: number;

const at = () => new Date(Date.UTC(2026, 10, 10, 9, 0, clock++));
function request(id: string, sender: string, recipient: string, status: string): Row {
  return {
    id, sender_id: sender, recipient_id: recipient, status, message: null, reason_line: '',
    responded_at: null, created_at: at(), preferred_format: null, cancelled_at: null,
  };
}
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** Each statement the request paths send, answered as Postgres would from `rows` and `bells`. */
function world(sqlIn: string, params: unknown[] = []) {
  const sql = flat(sqlIn);
  const p = params as string[];
  const ok = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });

  if (/pg_advisory_xact_lock/.test(sql)) return ok([]);
  if (/^SELECT recipient_id FROM user_pokes WHERE id = \$1 AND sender_id = \$2$/.test(sql)) {
    return ok(rows.filter(r => r.id === p[0] && r.sender_id === p[1]).map(r => ({ recipient_id: r.recipient_id })));
  }
  if (/^UPDATE user_pokes SET status = 'cancelled', cancelled_at = NOW\(\) WHERE id = \$1 AND sender_id = \$2 AND status = 'pending'/.test(sql)) {
    const r = rows.find(x => x.id === p[0] && x.sender_id === p[1] && x.status === 'pending');
    if (!r) return ok([]);
    r.status = 'cancelled';
    r.cancelled_at = at();
    return ok([{ id: r.id, recipient_id: r.recipient_id }]);
  }
  if (/^DELETE FROM notifications WHERE user_id = \$1 AND type = 'poke' AND link = \$2 AND is_read = FALSE$/.test(sql)) {
    const gone = bells.filter(b => b.user_id === p[0] && b.type === 'poke' && b.link === p[1] && !b.is_read);
    bells = bells.filter(b => !gone.includes(b));
    return ok([]);
  }
  if (/^SELECT sender_id, status FROM user_pokes WHERE id = \$1$/.test(sql)) {
    return ok(rows.filter(r => r.id === p[0]).map(r => ({ sender_id: r.sender_id, status: r.status })));
  }
  // sendPoke
  if (/FROM encounter_history/.test(sql)) return ok([]);
  if (/^UPDATE user_pokes SET status = 'accepted', responded_at = NOW\(\) WHERE sender_id = \$1 AND recipient_id = \$2 AND status = 'pending'/.test(sql)) {
    return ok([]); // nobody has asked back in these tests
  }
  if (/status = 'declined'/.test(sql) && /^SELECT id FROM user_pokes/.test(sql)) {
    return ok(rows.filter(r => r.sender_id === p[0] && r.recipient_id === p[1] && r.status === 'declined').map(r => ({ id: r.id })));
  }
  if (/^SELECT id FROM users WHERE id = \$1/.test(sql)) return ok([{ id: p[0] }]);
  if (/^INSERT INTO user_pokes/.test(sql)) {
    // 047's partial unique index: one PENDING request per direction per pair.
    if (rows.some(r => r.sender_id === p[1] && r.recipient_id === p[2] && r.status === 'pending')) {
      return Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }));
    }
    const r = request(p[0], p[1], p[2], 'pending');
    rows.push(r);
    return ok([r]);
  }
  if (/^SELECT first_name, display_name FROM users/.test(sql)) return ok([{ first_name: 'Ana', display_name: 'Ana A' }]);
  if (/^INSERT INTO notifications/.test(sql)) {
    bells.push({ user_id: p[1], type: 'poke', link: p[4], is_read: false });
    return ok([{ id: 'n-' + bells.length, created_at: at() }]);
  }
  // acceptPoke's claim
  if (/^SELECT sender_id FROM user_pokes WHERE id = \$1 AND recipient_id = \$2$/.test(sql)) {
    return ok(rows.filter(r => r.id === p[0] && r.recipient_id === p[1]).map(r => ({ sender_id: r.sender_id })));
  }
  if (/^UPDATE user_pokes SET status = \$3, responded_at = NOW\(\) WHERE id = \$1 AND recipient_id = \$2 AND status = 'pending'/.test(sql)) {
    const r = rows.find(x => x.id === p[0] && x.recipient_id === p[1] && x.status === 'pending');
    if (!r) return ok([]);
    r.status = p[2];
    return ok([r]);
  }
  if (/^SELECT id, sender_id, recipient_id, status, message, reason_line, responded_at, created_at, preferred_format FROM user_pokes WHERE id = \$1$/.test(sql)) {
    return ok(rows.filter(r => r.id === p[0]));
  }
  // getPokeWith / getPokeState
  if (/FROM user_pokes p WHERE \(\(p\.sender_id = \$1 AND p\.recipient_id = \$2\) OR \(p\.sender_id = \$2 AND p\.recipient_id = \$1\)\)/.test(sql)) {
    const allowed = /p\.status IN \('pending', 'accepted', 'declined'\)/.test(sql) ? ['pending', 'accepted', 'declined'] : null;
    const found = rows
      .filter(r => (r.sender_id === p[0] && r.recipient_id === p[1]) || (r.sender_id === p[1] && r.recipient_id === p[0]))
      .filter(r => !allowed || allowed.includes(r.status))
      .sort((x, y) => y.created_at.getTime() - x.created_at.getTime());
    return ok(found.slice(0, 1).map(r => ({ ...r, recipient_name: 'Bea' })));
  }
  if (/FROM user_pokes p WHERE p\.id = \$1 AND \(p\.sender_id = \$2 OR p\.recipient_id = \$2\)/.test(sql)) {
    return ok(rows.filter(r => r.id === p[0] && (r.sender_id === p[1] || r.recipient_id === p[1]))
      .map(r => ({ ...r, recipient_name: 'Bea', conversation_id: null })));
  }
  throw new Error(`unexpected SQL in withdraw test: ${sql.slice(0, 160)}`);
}

beforeEach(() => {
  clock = 0;
  rows = [request(P1, A, B, 'pending')];
  bells = [{ user_id: B, type: 'poke', link: requestBellLink(P1), is_read: false }];
  mockQuery.mockReset();
  mockQuery.mockImplementation(world);
  mockEmitEntities.mockClear();
});

describe('withdrawPoke', () => {
  it('the sender withdraws a waiting request: it becomes cancelled, with the time it was', async () => {
    await expect(withdrawPoke(P1, A)).resolves.toBeUndefined();
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].cancelled_at).toBeInstanceOf(Date);
  });

  it("deletes the recipient's unread bell row for it, and only that one", async () => {
    bells.push({ user_id: B, type: 'poke', link: requestBellLink('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), is_read: false });
    bells.push({ user_id: B, type: 'poke_accepted', link: requestBellLink(P1), is_read: false });
    await withdrawPoke(P1, A);
    expect(bells.find(b => b.type === 'poke' && b.link === requestBellLink(P1))).toBeUndefined();
    expect(bells).toHaveLength(2);
  });

  it('leaves a bell row the recipient already read (the bell draws it as gone)', async () => {
    bells[0].is_read = true;
    await withdrawPoke(P1, A);
    expect(bells).toHaveLength(1);
  });

  it("tells both members' screens and bells: user, invites and notifications, each their own", async () => {
    await withdrawPoke(P1, A);
    const calls = mockEmitEntities.mock.calls.map(c => ({ to: c[1], tags: c[2] }));
    expect(calls).toEqual(expect.arrayContaining([
      { to: [A], tags: [`user:${A}`, `user:${A}:invites`, `user:${A}:notifications`] },
      { to: [B], tags: [`user:${B}`, `user:${B}:invites`, `user:${B}:notifications`] },
    ]));
  });

  it('refuses the recipient (403) and changes nothing', async () => {
    await expect(withdrawPoke(P1, B)).rejects.toMatchObject({
      statusCode: 403, message: 'Only the person who sent this meeting request can withdraw it.',
    });
    expect(rows[0].status).toBe('pending');
    expect(bells).toHaveLength(1);
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('refuses anyone else (403)', async () => {
    await expect(withdrawPoke(P1, C)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('withdrawing twice is a 409 that says it is already withdrawn, and emits nothing the second time', async () => {
    await withdrawPoke(P1, A);
    mockEmitEntities.mockClear();
    await expect(withdrawPoke(P1, A)).rejects.toMatchObject({
      statusCode: 409, code: 'MEETING_REQUEST_ALREADY_ANSWERED',
      message: 'You already withdrew this request.', details: { status: 'cancelled' },
    });
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted', "They already accepted your request, so you're connected."],
    ['declined', 'They already answered this request.'],
  ])('a request already %s cannot be withdrawn (409, its status in details)', async (status, message) => {
    rows[0].status = status;
    await expect(withdrawPoke(P1, A)).rejects.toMatchObject({ statusCode: 409, message, details: { status } });
    expect(rows[0].status).toBe(status);
  });

  it('a request that does not exist is a 404', async () => {
    await expect(withdrawPoke('cccccccc-cccc-4ccc-8ccc-cccccccccccc', A)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('takes the pair lock before the claim, as every answer does', async () => {
    await withdrawPoke(P1, A);
    const order = mockQuery.mock.calls.map(c => flat(String(c[0])));
    const lock = order.findIndex(s => /pg_advisory_xact_lock/.test(s));
    const claim = order.findIndex(s => /SET status = 'cancelled'/.test(s));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(claim);
  });
});

describe('after a withdrawal the sender may ask again', () => {
  it('a new request is inserted beside the cancelled one (the unique index covers pending rows only)', async () => {
    await withdrawPoke(P1, A);
    await expect(sendPoke(A, B, 'second try')).resolves.toMatchObject({ senderId: A, recipientId: B, status: 'pending' });
    expect(rows.map(r => r.status)).toEqual(['cancelled', 'pending']);
    // And the new request rings the recipient's bell again.
    expect(bells.filter(b => b.user_id === B && !b.is_read)).toHaveLength(1);
  });

  it('without the withdrawal, a second ask is still refused as a duplicate (the existing row is pending)', async () => {
    await expect(sendPoke(A, B, 'again')).rejects.toMatchObject({ statusCode: 409 });
  });

  it("047's unique index is partial on status = 'pending', which is what lets a cancelled row stand beside a new one", () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../../db/migrations/047_user_pokes.sql'), 'utf8');
    expect(flat(sql)).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_pokes_unique_pending ON user_pokes(sender_id, recipient_id) WHERE status = \'pending\';');
  });
});

describe('a withdrawn request reads as no request at all', () => {
  it('getPokeWith skips it: the person brief and the old profile see "none", from either side', async () => {
    await withdrawPoke(P1, A);
    await expect(getPokeWith(A, B)).resolves.toBeNull();
    await expect(getPokeWith(B, A)).resolves.toBeNull();
  });

  it('getPokeWith still finds an older request standing behind a withdrawn one (B asked A earlier and was declined)', async () => {
    rows.unshift({ ...request('dddddddd-dddd-4ddd-8ddd-dddddddddddd', B, A, 'declined'), created_at: new Date(Date.UTC(2026, 9, 1)) });
    await withdrawPoke(P1, A);
    await expect(getPokeWith(A, B)).resolves.toMatchObject({ status: 'declined', sentByMe: false });
  });

  it('getPokeState, opened by id (an old email), says it was withdrawn', async () => {
    await withdrawPoke(P1, A);
    await expect(getPokeState(P1, B)).resolves.toMatchObject({ status: 'cancelled', sentByMe: false, conversationId: null });
  });

  it('accepting a withdrawn request is a 409 that says they withdrew it (not "You already declined")', async () => {
    await withdrawPoke(P1, A);
    await expect(acceptPoke(P1, B)).rejects.toMatchObject({
      statusCode: 409, message: 'They withdrew this meeting request.', details: { status: 'cancelled' },
    });
    expect(rows[0].status).toBe('cancelled');
  });

  it('a withdrawn request is never a "no": sending again is not refused as declined', async () => {
    rows[0].status = 'cancelled';
    await expect(sendPoke(A, B)).resolves.toMatchObject({ status: 'pending' });
  });
});

// Every reader of user_pokes that asks "is there a live request?" must say pending or accepted, never "anything but
// declined", which would count a withdrawn request as asked.
describe('no reader counts a withdrawn request as asked or connected', () => {
  const SERVER_SRC = path.join(__dirname, '../../..');
  const read = (rel: string) => flat(fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8'));

  it('connected means accepted only (CONNECTION_SIGNALS_SQL)', () => {
    const sql = flat(CONNECTION_SIGNALS_SQL);
    expect(sql).toContain("FROM user_pokes p WHERE (p.sender_id = $1 OR p.recipient_id = $1) AND p.status = 'accepted'");
    expect(sql).not.toMatch(/<> 'declined'|!= 'declined'/);
  });

  it.each([
    'services/matching/agent-matching.service.ts',
    'services/matching/platform-match.service.ts',
    'services/user/user-search.service.ts',
    'services/poke/poke.service.ts',
    'services/people/person-brief.service.ts',
    'services/people/connections.service.ts',
    'services/dm/call-eligibility.ts',
    'services/notifications/notification-list.service.ts',
  ])('%s never reads "not declined" as a live request', (rel) => {
    expect(read(rel)).not.toMatch(/status (<>|!=) 'declined'/);
  });

  it('agents: the only "not declined" left reads a lateral that already skips withdrawn requests', () => {
    const src = read('services/matching/agent.repo.ts');
    expect(src.match(/status (<>|!=) 'declined'/g)).toEqual(["status <> 'declined'"]);
    expect(src).toContain("AND (p.status IS NULL OR p.status <> 'declined')");
    expect(src).toContain("AND pk.status IN ('pending', 'accepted', 'declined') ORDER BY pk.created_at DESC LIMIT 1");
    // Counts, stickiness: pending or accepted.
    expect(src.match(/p\.status IN \('pending', 'accepted'\)/g)).toHaveLength(2);
  });

  it("For You: the request a card shows is pending or accepted, and the already-in-touch rule reads exact statuses", () => {
    const src = read('services/matching/platform-match.service.ts');
    expect(src).toContain("FROM user_pokes p2 WHERE p2.status IN ('pending', 'accepted')");
    // F5's rule (notAlreadyInTouchSql): only an accepted request excludes, only a pending one keeps; a withdrawn
    // (cancelled) request is neither, so it is no request at all.
    const inTouch = flat(notAlreadyInTouchSql('$1', 'u'));
    expect(inTouch).toContain("FROM user_pokes ap WHERE ap.status = 'accepted'");
    expect(inTouch).toContain("FROM user_pokes pp WHERE pp.status = 'pending'");
    expect(inTouch).not.toMatch(/status (<>|!=) 'declined'|cancelled/);
  });

  it('agents scoring: stickiness and the met-override are pending or accepted', () => {
    const src = read('services/matching/agent-matching.service.ts');
    expect(src).toContain("FROM user_pokes p WHERE p.status IN ('pending', 'accepted') AND p.agent_id = $2");
    expect(src).toContain("SELECT 1 FROM user_pokes ip WHERE ip.status IN ('pending', 'accepted')");
  });

  it('the bell draws a withdrawn request as gone, so a read row never offers Accept', () => {
    const src = read('services/notifications/notification-list.service.ts');
    expect(src).toContain("CASE -- 10 Nov 2026");
    expect(src).toMatch(/WHEN p\.status = 'cancelled' THEN 'gone' WHEN p\.status = 'pending' AND/);
  });
});

describe('migration 132', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../db/migrations/132_meeting_request_withdraw.sql'), 'utf8');
  const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

  it('re-adds the status CHECK under its own name with cancelled, and adds cancelled_at, idempotently', () => {
    expect(flat(statements)).toContain('ALTER TABLE user_pokes DROP CONSTRAINT IF EXISTS user_pokes_status_check;');
    expect(flat(statements)).toContain(
      "ALTER TABLE user_pokes ADD CONSTRAINT user_pokes_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled'));");
    expect(flat(statements)).toContain('ALTER TABLE user_pokes ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;');
  });

  it('has no top-level transaction control (the runner wraps each file)', () => {
    expect(statements).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\s*;/im);
  });
});
