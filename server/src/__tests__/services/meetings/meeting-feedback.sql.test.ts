// ─── Feedback after a meeting, on a real Postgres (30 Oct 2026, item 5c) ──────────────────────────
//
// What the SQL itself must do, which a stand-in database cannot show: migration 123 on a table that already holds
// the profile sheet's answer, the upsert on its partial unique index (a second press edits the one row, two
// presses at once still leave one), the admin list's two people, the other person's answer beside each row, the
// "Only with problems" filter and its pages, and who may answer at all.
//
// Everything happens in a schema of its own, made from the real tables (LIKE … INCLUDING ALL) and dropped at the
// end: no row of the database is read or written. Opt-in, because it needs a local Postgres (it refuses anything
// else); without one it is skipped:
//
//   MEETINGS_SQL_TEST_DB=postgresql://…@127.0.0.1:54329/rsn_c2 npx jest src/__tests__/services/meetings/meeting-feedback.sql.test.ts

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';

const mockEmits: Array<{ users: string[]; entities: string[] }> = [];
jest.mock('../../../index', () => ({ __esModule: true, io: {} }));
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  emitEntities: async (_io: unknown, users: string[], entities: string[]) => { mockEmits.push({ users, entities }); },
}));
const mockAdminFanout = jest.fn(async (_scope: string) => undefined);
jest.mock('../../../realtime/fanout', () => ({ __esModule: true, fanoutAdminEntities: (scope: string) => mockAdminFanout(scope) }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const url = process.env.MEETINGS_SQL_TEST_DB;
const suite = url ? describe : describe.skip;
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../../db/migrations/123_meeting_feedback.sql'), 'utf8');

suite('feedback after a meeting (real Postgres)', () => {
  const schema = `zz_meeting_feedback_${Date.now()}`;
  let admin: Client;
  let previousUrl: string | undefined;
  let db: typeof import('../../../db');
  let feedback: typeof import('../../../services/meetings/meeting-feedback.service');
  let outcomes: typeof import('../../../services/people/meeting-outcome.service');

  const NOW = new Date();
  const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const [A, B] = [randomUUID(), randomUUID()].sort(); // the pair's tables keep the lower id first
  const C = randomUUID();
  let conv: string;
  let held: string; // a meeting that started 20 minutes ago, written before migration 123 ran
  let later: string; // a meeting that has not started
  let cancelled: string;
  let legacyId: string;

  const q = (sql: string, params: unknown[] = []) => admin.query(sql.replace(/\bS\./g, `${schema}.`), params);
  const rowsAbout = async (meetingId: string) =>
    (await q(`SELECT * FROM S.meeting_outcomes WHERE meeting_id = $1 ORDER BY user_id`, [meetingId])).rows;

  beforeAll(async () => {
    if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url!)) throw new Error('MEETINGS_SQL_TEST_DB must be a local database');
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['users', 'user_blocks', 'dm_conversations', 'encounter_history', 'meetings']) {
      await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // meeting_outcomes as migration 101 made it, whatever the shared database has applied since.
    await admin.query(`CREATE TABLE ${schema}.meeting_outcomes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL, target_user_id UUID NOT NULL,
      worth_continuing TEXT NOT NULL CHECK (worth_continuing IN ('yes', 'maybe', 'no')),
      outcome_keys TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (user_id <> target_user_id))`);
    for (const [id, name] of [[A, 'Ana Feedback'], [B, 'Bo Feedback'], [C, 'Cy Outsider']]) {
      await q(`INSERT INTO S.users (id, email, display_name, first_name, last_name, status) VALUES ($1, $2, $3, $3, 'Test', 'active')`,
        [id, `${id}@meeting-feedback.invalid`, name]);
    }
    conv = randomUUID();
    await q(`INSERT INTO S.dm_conversations (id, user_a_id, user_b_id) VALUES ($1, $2, $3)`, [conv, A, B]);
    const meeting = async (startAt: Date, status = 'scheduled') => (await q(
      `INSERT INTO S.meetings (conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, status)
       VALUES ($1, $2, $3, $4, 30, 'video', $5) RETURNING id`, [conv, A, B, startAt, status])).rows[0].id as string;
    held = await meeting(minutesFromNow(-20));
    later = await meeting(minutesFromNow(60 * 24));
    cancelled = await meeting(minutesFromNow(-90), 'cancelled');
    // The profile sheet's answer, as production holds one: no meeting, written before 123.
    legacyId = (await q(
      `INSERT INTO S.meeting_outcomes (user_id, target_user_id, worth_continuing, outcome_keys, created_at)
       VALUES ($1, $2, 'yes', '{advice}', $3) RETURNING id`, [A, B, minutesFromNow(-60 * 24 * 3)])).rows[0].id;

    // Migration 123, on this schema's tables, twice (it must change nothing the second time).
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(MIGRATION);
    await admin.query(MIGRATION);
    await admin.query('SET search_path TO public');

    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    db = await import('../../../db');
    feedback = await import('../../../services/meetings/meeting-feedback.service');
    outcomes = await import('../../../services/people/meeting-outcome.service');
  });

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    process.env.DATABASE_URL = previousUrl;
  });

  beforeEach(() => { mockEmits.length = 0; mockAdminFanout.mockClear(); });

  it('migration 123 keeps the profile sheet\'s answer as it was, with no meeting and a NULL source', async () => {
    const row = (await q(`SELECT * FROM S.meeting_outcomes WHERE id = $1`, [legacyId])).rows[0];
    expect(row).toMatchObject({ meeting_id: null, source: null, problems: [], problem_text: null, worth_continuing: 'yes', outcome_keys: ['advice'] });
  });

  it('a meeting from before migration 123 takes an answer; a second press edits that row instead of adding one', async () => {
    const first = await feedback.submitMeetingFeedback(A, held, { worthContinuing: 'yes', problems: [] }, NOW);
    expect(first).toMatchObject({ meetingId: held, worthContinuing: 'yes', problems: [], problemText: null });
    const again = await feedback.submitMeetingFeedback(A, held, {
      worthContinuing: 'maybe', problems: ['other', 'connection', 'connection'], problemText: '  It froze twice.  ',
    }, NOW);
    expect(again.id).toBe(first.id);
    expect(again.createdAt).toBe(first.createdAt);
    const rows = await rowsAbout(held);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: A, target_user_id: B, source: 'meeting', worth_continuing: 'maybe',
      problems: ['connection', 'other'], problem_text: 'It froze twice.', outcome_keys: [],
    });
  });

  it('two presses at once still leave one row', async () => {
    await Promise.all([
      feedback.submitMeetingFeedback(B, held, { worthContinuing: 'no' }, NOW),
      feedback.submitMeetingFeedback(B, held, { worthContinuing: 'maybe', problems: ['connection'], problemText: 'Bad line' }, NOW),
    ]);
    const mine = (await rowsAbout(held)).filter((r) => r.user_id === B);
    expect(mine).toHaveLength(1);
    expect(mine[0].target_user_id).toBe(A);
    await feedback.submitMeetingFeedback(B, held, { worthContinuing: 'maybe', problems: ['connection'], problemText: 'Bad line' }, NOW);
  });

  it('each person reads only their own answer', async () => {
    expect(await feedback.readMyFeedback(A, held)).toEqual({ worthContinuing: 'maybe', problems: ['connection', 'other'], problemText: 'It froze twice.' });
    expect(await feedback.readMyFeedback(B, held)).toEqual({ worthContinuing: 'maybe', problems: ['connection'], problemText: 'Bad line' });
    expect(await feedback.readMyFeedback(C, held)).toBeNull();
    expect(await feedback.readMyFeedback(A, later)).toBeNull();
  });

  it('someone who is not one of the two is refused with a 403 and a sentence, and nothing is written', async () => {
    await expect(feedback.submitMeetingFeedback(C, held, { worthContinuing: 'yes' }, NOW)).rejects.toMatchObject({
      statusCode: 403, message: 'Only the two people in this meeting can say how it went.',
    });
    expect((await q(`SELECT count(*)::int AS n FROM S.meeting_outcomes WHERE user_id = $1`, [C])).rows[0].n).toBe(0);
  });

  it('a meeting that has not started, or was cancelled, takes no answer (409); an unknown one is a 404', async () => {
    await expect(feedback.submitMeetingFeedback(A, later, { worthContinuing: 'yes' }, NOW)).rejects.toMatchObject({
      statusCode: 409, code: 'MEETING_NOT_STARTED', message: 'You can say how it went once the meeting has started.',
    });
    await expect(feedback.submitMeetingFeedback(A, cancelled, { worthContinuing: 'yes' }, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'MEETING_CANCELLED' });
    await expect(feedback.submitMeetingFeedback(A, randomUUID(), { worthContinuing: 'yes' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(await rowsAbout(later)).toHaveLength(0);
  });

  it('the profile sheet still writes its answer with no meeting and a NULL source (POST /people/:id/outcome is unchanged)', async () => {
    const saved = await outcomes.recordOutcome(B, A, 'yes', ['follow_up']);
    const row = (await q(`SELECT meeting_id, source, problems FROM S.meeting_outcomes WHERE id = $1`, [saved.id])).rows[0];
    expect(row).toEqual({ meeting_id: null, source: null, problems: [] });
  });

  it('the person brief\'s read sees the profile answer and the answer after the meeting alike', async () => {
    // person-brief.service.ts reads exactly this.
    const brief = await db.query<{ worth_continuing: string; outcome_keys: string[] }>(
      `SELECT worth_continuing, outcome_keys, created_at FROM meeting_outcomes
        WHERE user_id = $1 AND target_user_id = $2 ORDER BY created_at DESC LIMIT 5`, [A, B]);
    expect(brief.rows.map((r) => r.worth_continuing)).toEqual(['maybe', 'yes']);
    expect(brief.rows[1].outcome_keys).toEqual(['advice']);
  });

  it('the admin list shows every answer newest first, both people, and the other person\'s answer beside each', async () => {
    const page = await feedback.listAdminFeedback({ problemsOnly: false, limit: 50 });
    const byFrom = (id: string, source: string | null) => page.items.find((r) => r.from.userId === id && r.source === source);
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
    const ana = byFrom(A, 'meeting')!;
    expect(ana).toMatchObject({
      meeting: { id: held, durationMin: 30, kind: 'video' },
      from: { userId: A, displayName: 'Ana Feedback', isFormerMember: false },
      about: { userId: B, displayName: 'Bo Feedback', isFormerMember: false },
      answer: { worthContinuing: 'maybe', problems: ['connection', 'other'], problemText: 'It froze twice.' },
      theirAnswer: { worthContinuing: 'maybe', problems: ['connection'], problemText: 'Bad line' },
    });
    expect(byFrom(B, 'meeting')!.theirAnswer).toMatchObject({ worthContinuing: 'maybe', problemText: 'It froze twice.' });
    const legacy = page.items.find((r) => r.id === legacyId)!;
    expect(legacy).toMatchObject({ source: null, meeting: null, theirAnswer: null, answer: { outcomes: ['advice'] } });
    expect(page.items[page.items.length - 1].id).toBe(legacyId);
  });

  it('"Only with problems" keeps the answers that picked or wrote one', async () => {
    const page = await feedback.listAdminFeedback({ problemsOnly: true, limit: 50 });
    expect(page.items.map((r) => r.from.userId).sort()).toEqual([A, B].sort());
  });

  it('pages walk every row once, a row at a time', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await feedback.listAdminFeedback({ problemsOnly: false, limit: 1, cursor });
      seen.push(...page.items.map((r) => r.id));
      if (!page.nextCursor) break;
      expect(feedback.isAdminFeedbackCursor(page.nextCursor)).toBe(true);
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it('a person removed since reads "Former member" on the list, and their id still opens the inspector', async () => {
    await q(`UPDATE S.users SET status = 'deactivated' WHERE id = $1`, [B]);
    const page = await feedback.listAdminFeedback({ problemsOnly: false, limit: 50 });
    const ana = page.items.find((r) => r.from.userId === A && r.source === 'meeting')!;
    expect(ana.about).toEqual({ userId: B, displayName: 'Former member', isFormerMember: true });
    expect(page.items.find((r) => r.from.userId === B && r.source === 'meeting')!.from.displayName).toBe('Former member');
    const csv = feedback.adminFeedbackCsv(page.items);
    expect(csv).not.toContain('Bo Feedback');
    expect(csv).toContain('Former member');
  });

  it('a removed participant cannot answer (403), whatever the sign-in check still remembers', async () => {
    await expect(feedback.submitMeetingFeedback(B, held, { worthContinuing: 'no' }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    expect((await rowsAbout(held)).find((r) => r.user_id === B).worth_continuing).toBe('maybe');
    await q(`UPDATE S.users SET status = 'active' WHERE id = $1`, [B]);
  });

  it('a block between the two hides the meeting from feedback as from its page (404)', async () => {
    await q(`INSERT INTO S.user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [B, A]);
    await expect(feedback.submitMeetingFeedback(A, held, { worthContinuing: 'no' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await q(`DELETE FROM S.user_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [B, A]);
  });

  it('a saved answer tells the author\'s meeting page and person brief, and every admin\'s list; never the other person', async () => {
    await feedback.announceFeedback(A, held);
    expect(mockEmits).toEqual([{ users: [A], entities: [`meeting:${held}`, `user:${A}`] }]);
    expect(mockAdminFanout).toHaveBeenCalledWith('meeting-feedback');
  });
});
