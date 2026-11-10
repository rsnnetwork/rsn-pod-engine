// ─── Production's client after R10f: the request it sends, and what it reads back (30 Oct 2026) ───
//
// app.rsn.network runs origin/main's client, which knows nothing of the note and REASON's line kept
// apart. What it does, read from that client:
//   - MatchesPage.tsx posts `/matches/platform/:userId/interest` with NO body ("I want to meet");
//   - the old profile posts `/pokes` with `{ recipientId }` and no message;
//   - MeetingRequests.tsx draws `message` under the sender's name (GET /pokes/received);
//   - MessagesPage.tsx draws a `kind: 'system'` row with SystemMessageCard, whose last branch draws the
//     row's `content` for "any card kind an older client does not know yet" (SystemMessageCard.tsx:160-176).
// This drives the real routes and services, with only the database stood in for, and checks each of
// those still works: 201s, `message` still the one text (note, then REASON's line), and an accept that
// opens the thread with a card whose content reads right on its own.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true,
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000, clientUrl: 'https://app.rsn.network',
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../index', () => ({ io: { to: () => ({ emit: jest.fn() }) }, __esModule: true }));
jest.mock('../../realtime/emit', () => ({ emitEntities: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../realtime/fanout', () => ({ fanoutUserEntity: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../services/block/block.service', () => ({ areBlocked: jest.fn().mockResolvedValue(false), __esModule: true }));
jest.mock('../../services/orchestration/handlers/dm-handlers', () => ({ broadcastDmMessage: jest.fn().mockResolvedValue(undefined), __esModule: true }));
jest.mock('../../services/email/email.service', () => ({
  sendPokeReceivedEmail: jest.fn().mockResolvedValue(undefined),
  sendPokeAcceptedEmail: jest.fn().mockResolvedValue(undefined),
  isEmailTypeEnabled: jest.fn().mockResolvedValue(false),
  __esModule: true,
}));
jest.mock('../../services/notification-prefs/notification-prefs.service', () => ({
  shouldSendEmail: jest.fn().mockResolvedValue(false), shouldSendBell: jest.fn().mockResolvedValue(true), __esModule: true,
}));

import matchesRoutes from '../../routes/matches';
import pokesRoutes from '../../routes/pokes';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { listMessages } from '../../services/dm/dm.service';

const app = express();
app.use(express.json());
app.use('/matches', matchesRoutes);
app.use('/pokes', pokesRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const FATIMA = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d01';
const IQBAL = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d02';
const bearer = (sub: string) => ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });

// Fatima is looking for investors; Iqbal is an Angel Investor. Profiles as loadProfile reads them.
const PROFILES: Record<string, Record<string, unknown>> = {
  [FATIMA]: {
    id: FATIMA, displayName: 'Fatima Khan', firstName: 'Fatima', professionalRole: ['Founder'],
    whoIWantToMeet: 'investors and angels for my seed round', onboardingCompleted: true,
  },
  [IQBAL]: {
    id: IQBAL, displayName: 'Iqbal Shah', firstName: 'Iqbal', professionalRole: ['Angel Investor'],
    expertiseText: 'early stage SaaS investing', onboardingCompleted: true,
  },
};
const NAMES: Record<string, { first_name: string; display_name: string }> = {
  [FATIMA]: { first_name: 'Fatima', display_name: 'Fatima Khan' },
  [IQBAL]: { first_name: 'Iqbal', display_name: 'Iqbal Shah' },
};
const LINE = 'Fatima is looking to meet investors, and Iqbal is an Angel Investor.';

interface Row { [k: string]: unknown; id: string; sender_id: string; recipient_id: string; status: string }

function armDb() {
  const requests: Row[] = [];
  const messages: Array<Record<string, unknown>> = [];
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    const none = { rows: [] as unknown[] };
    if (/SELECT status(?:, account_kind)? FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ status: 'active', account_kind: 'member' }] });
    if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: PROFILES[params[0] as string] ? [PROFILES[params[0] as string]] : [] });
    if (/SELECT id, first_name, display_name FROM users WHERE id = ANY/.test(sql)) {
      return Promise.resolve({ rows: (params[0] as string[]).map(id => ({ id, ...NAMES[id] })) });
    }
    if (/SELECT first_name, display_name FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [NAMES[params[0] as string]] });
    if (/SELECT id FROM users WHERE id/.test(sql)) return Promise.resolve({ rows: [{ id: params[0] }] });
    if (/INSERT INTO user_pokes/.test(sql)) {
      const r: Row = {
        id: params[0] as string, sender_id: params[1] as string, recipient_id: params[2] as string, status: 'pending',
        message: params[3], reason_line: params[6], responded_at: null, created_at: new Date(), preferred_format: params[5],
      };
      requests.push(r);
      return Promise.resolve({ rows: [{ ...r }] });
    }
    if (/FROM user_pokes p\s+JOIN users u ON u\.id = p\.sender_id/.test(sql)) {
      return Promise.resolve({ rows: requests.filter(r => r.recipient_id === params[0] && r.status === 'pending').map(r => ({
        ...r, ...NAMES[r.sender_id], avatar_url: null, job_title: null, company: null, recipient_name: NAMES[r.recipient_id].first_name,
      })) });
    }
    if (/SELECT sender_id FROM user_pokes WHERE id = \$1 AND recipient_id = \$2/.test(sql)) {
      return Promise.resolve({ rows: requests.filter(r => r.id === params[0] && r.recipient_id === params[1]) });
    }
    if (/UPDATE user_pokes[\s\S]*WHERE id = \$1 AND recipient_id = \$2 AND status = 'pending'/.test(sql)) {
      const r = requests.find(x => x.id === params[0] && x.recipient_id === params[1] && x.status === 'pending');
      if (!r) return Promise.resolve(none);
      r.status = 'accepted';
      return Promise.resolve({ rows: [{ ...r }] });
    }
    if (/INSERT INTO dm_conversations/.test(sql)) return Promise.resolve({ rows: [{ id: 'conv-1' }] });
    if (/INSERT INTO direct_messages/.test(sql)) {
      const m = {
        id: `dm-${messages.length + 1}`, conversation_id: params[1], from_user_id: params[2], content: params[3],
        kind: params[4], system_meta: params[5] ? JSON.parse(params[5] as string) : null,
        read_at: null, created_at: new Date(Date.now() + messages.length), reactions: {},
        attachment_url: null, attachment_type: null, attachment_meta: null,
      };
      messages.push(m);
      return Promise.resolve({ rows: [m] });
    }
    if (/FROM dm_conversations WHERE id = \$1/.test(sql)) {
      return Promise.resolve({ rows: [{ user_a_id: FATIMA, user_b_id: IQBAL, user_a_deleted_at: null, user_b_deleted_at: null }] });
    }
    if (/SELECT COUNT\(\*\)::text AS count FROM direct_messages/.test(sql)) return Promise.resolve({ rows: [{ count: String(messages.length) }] });
    if (/FROM direct_messages m/.test(sql)) return Promise.resolve({ rows: [...messages].reverse() });
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n-1', created_at: new Date() }] });
    return Promise.resolve(none);
  });
  return { requests, messages };
}

beforeEach(() => mockQuery.mockReset());

describe('production\'s client after the note and REASON\'s line are kept apart', () => {
  it('"I want to meet" with no body: 201, and message is still REASON\'s words under their heading, for its card', async () => {
    armDb();
    const res = await request(app).post(`/matches/platform/${IQBAL}/interest`).set(bearer(FATIMA));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'pending', note: null, reasonLine: LINE, message: `Why REASON suggested this: ${LINE}` });
  });

  it('"I want to meet" from a member with no stated want: 201, with nothing made up', async () => {
    armDb();
    const res = await request(app).post(`/matches/platform/${FATIMA}/interest`).set(bearer(IQBAL));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ note: null, reasonLine: null, message: null });
  });

  it('POST /pokes with { recipientId } only, as the old profile sends it: 201 with no message', async () => {
    armDb();
    const res = await request(app).post('/pokes').set(bearer(FATIMA)).send({ recipientId: IQBAL });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ message: null, note: null, reasonLine: null });
  });

  it('the recipient\'s list still carries message as the one text the old card draws', async () => {
    armDb();
    await request(app).post(`/matches/platform/${IQBAL}/interest`).set(bearer(FATIMA)).send({ note: 'Hello Iqbal' });
    const res = await request(app).get('/pokes/received').set(bearer(IQBAL));
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      message: `Hello Iqbal\n\nWhy REASON suggested this: ${LINE}`, note: 'Hello Iqbal', reasonLine: LINE, senderFirstName: 'Fatima',
    });
  });

  it('after Accept, the thread production reads opens with a system row whose content reads right on its own, then the note', async () => {
    const db = armDb();
    const sent = await request(app).post(`/matches/platform/${IQBAL}/interest`).set(bearer(FATIMA)).send({ note: 'Hello Iqbal' });
    const accepted = await request(app).post(`/pokes/${sent.body.data.id}/accept`).set(bearer(IQBAL));
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.conversationId).toBe('conv-1');

    const { messages } = await listMessages('conv-1', FATIMA);
    const [card, note] = [...messages].reverse();
    // Production's MessagesPage draws a kind 'system' row with SystemMessageCard, and an 'introduction'
    // is a kind it does not know, so it draws `content`: a whole sentence in nobody's voice.
    expect(card).toMatchObject({ kind: 'system', fromUserId: FATIMA, systemMeta: { type: 'introduction' } });
    expect(card.content).toBe(`Fatima asked to meet Iqbal, and Iqbal accepted. Why REASON suggested this: ${LINE}`);
    expect(note).toMatchObject({ kind: 'user', fromUserId: FATIMA, content: 'Hello Iqbal' });
    expect(db.messages).toHaveLength(2);
  });
});
