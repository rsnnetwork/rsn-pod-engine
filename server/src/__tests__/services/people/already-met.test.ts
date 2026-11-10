// "Already met" (10 Nov 2026): a private, one-sided marker. The database stand-in answers what Postgres would; the SQL is
// read for the rules it must hold (each statement is also run for real, read-only, against production before shipping).
import { readFileSync } from 'fs';
import { join } from 'path';
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import { markAlreadyMet, unmarkAlreadyMet, isAlreadyMet } from '../../../services/people/already-met.service';
import { notMarkedMetSql, notAlreadyInTouchSql } from '../../../services/matching/platform-match.service';
import { getUserEncounters } from '../../../services/rating/rating.service';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');
const src = (rel: string) => readFileSync(join(__dirname, '../../..', rel), 'utf8').replace(/\r\n/g, '\n');
const userExists = (sql: string) => Promise.resolve({ rows: /SELECT id FROM users/.test(sql) ? [{ id: 'u-b' }] : [] });

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [] }); });

describe('marking someone as already met', () => {
  it('writes one row for the pair, and marking twice is the same as once', async () => {
    mockQuery.mockImplementation(userExists);
    await markAlreadyMet('u-a', 'u-b');
    await markAlreadyMet('u-a', 'u-b');
    const inserts = mockQuery.mock.calls.filter((c) => /INSERT INTO already_met/.test(String(c[0])));
    expect(inserts).toHaveLength(2);
    expect(flat(inserts[0][0])).toMatch(/ON CONFLICT \(user_id, target_user_id\) DO NOTHING/);
    expect(inserts[0][1]).toEqual(['u-a', 'u-b']);
  });

  it('is not a connection: it writes no encounter and no request', async () => {
    mockQuery.mockImplementation(userExists);
    await markAlreadyMet('u-a', 'u-b');
    const all = mockQuery.mock.calls.map((c) => String(c[0])).join('\n');
    expect(all).not.toMatch(/encounter_history|user_pokes|dm_conversations/);
  });

  it('takes the person off the marker\'s own stored searches only', async () => {
    mockQuery.mockImplementation(userExists);
    await markAlreadyMet('u-a', 'u-b');
    const del = mockQuery.mock.calls.find((c) => /DELETE FROM agent_matches/.test(String(c[0])))!;
    expect(flat(del[0])).toMatch(/a\.user_id = \$1 AND am\.candidate_user_id = \$2/);
    expect(del[1]).toEqual(['u-a', 'u-b']);
  });

  it('refuses yourself and an unknown member, and writes nothing for either', async () => {
    await expect(markAlreadyMet('u-a', 'u-a')).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
    await expect(markAlreadyMet('u-a', 'u-ghost')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO already_met/.test(String(c[0])))).toBe(false);
  });

  it('unmarking deletes this member\'s mark on this person only, and reads back', async () => {
    await unmarkAlreadyMet('u-a', 'u-b');
    expect(flat(mockQuery.mock.calls[0][0])).toMatch(/DELETE FROM already_met WHERE user_id = \$1 AND target_user_id = \$2/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['u-a', 'u-b']);
    mockQuery.mockResolvedValueOnce({ rows: [{ marked: true }] });
    expect(await isAlreadyMet('u-a', 'u-b')).toBe(true);
    mockQuery.mockResolvedValueOnce({ rows: [{ marked: false }] });
    expect(await isAlreadyMet('u-b', 'u-a')).toBe(false);
  });
});

describe('who a mark hides from', () => {
  it('For You skips only the marker\'s own marked people, in one direction', () => {
    const sql = flat(notMarkedMetSql('$1', 'u'));
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM already_met am WHERE am\.user_id = \$1 AND am\.target_user_id = u\.id\)/);
    expect(sql).not.toMatch(/am\.target_user_id = \$1/); // the reverse direction is never read
  });

  it('loadCandidates applies it, and the in-touch rule is unchanged by it', () => {
    const s = flat(src('services/matching/platform-match.service.ts'));
    expect(s).toContain("AND ${notMarkedMetSql('$1', 'u')}");
    expect(flat(notAlreadyInTouchSql('$1', 'u'))).not.toMatch(/already_met/);
  });

  it('agent searches skip them, for a rescore and for a newcomer', () => {
    const s = flat(src('services/matching/agent-matching.service.ts'));
    expect(s).toContain('SELECT 1 FROM already_met am WHERE am.user_id = $1 AND am.target_user_id = u.id');
    expect(s).toContain('SELECT 1 FROM already_met am WHERE am.user_id = $1 AND am.target_user_id = $2');
  });

  it('is not part of the connection signals, so no invite list or connection count changes', () => {
    expect(src('services/people/connections.service.ts')).not.toMatch(/already_met/);
  });

  it('Everyone keeps the person and says so, from the viewer\'s own mark', () => {
    const s = flat(src('services/people/everyone.service.ts'));
    expect(s).toMatch(/am\.user_id = \$1 AND am\.target_user_id = u\.id\) AS already_met/);
    expect(s).toContain('alreadyMet: !!r.already_met');
  });

  it('the brief carries the flag and leaves the relationship state to the real signals', () => {
    const s = flat(src('services/people/person-brief.service.ts'));
    expect(s).toContain('alreadyMet: markedMet');
    const stateRule = s.slice(s.indexOf('const state: RelationshipState'), s.indexOf('const person = toPublicMember'));
    expect(stateRule).not.toContain('markedMet');
  });
});

describe('People you have met lists marked people', () => {
  it('adds marked people with no encounter row, labelled, newest first', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'enc-1', otherUserId: 'u-c', lastMetAt: '2026-10-01T00:00:00Z', markedMet: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'am-1', otherUserId: 'u-b', lastMetAt: '2026-11-01T00:00:00Z', displayName: 'Bea' }] });
    const rows = await getUserEncounters('u-a');
    expect(rows.map((r) => r.otherUserId)).toEqual(['u-b', 'u-c']);
    expect(rows[0]).toMatchObject({ markedMet: true, mutual: false });
    const sql = flat(mockQuery.mock.calls[1][0]);
    expect(sql).toMatch(/am\.user_id = \$1/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM encounter_history eh/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b/);
    expect(sql).toMatch(/u\.status = 'active'/);
  });

  it('flags a person who has both an encounter and a mark on the encounter row, and never lists them twice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'enc-1', otherUserId: 'u-c', lastMetAt: '2026-10-01T00:00:00Z' }] });
    await getUserEncounters('u-a');
    expect(flat(mockQuery.mock.calls[0][0])).toMatch(/AS "markedMet"/);
    expect(flat(mockQuery.mock.calls[1][0])).toMatch(/NOT EXISTS \(SELECT 1 FROM encounter_history eh/);
  });

  it('Mutual Matches never includes a mark', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getUserEncounters('u-a', true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('the route and the migration', () => {
  it('PUT and DELETE are authenticated, rate limited, validated and emit only the member\'s own tags', () => {
    const s = src('routes/people.ts');
    for (const verb of ['put', 'delete']) {
      const at = s.indexOf(`router.${verb}(\n  '/:userId/already-met'`);
      expect(at).toBeGreaterThan(-1);
      const block = s.slice(at, s.indexOf('\n);', at));
      expect(block).toContain('authenticate');
      expect(block).toContain('peopleWriteLimiter');
      expect(block).toContain("validate(userParams, 'params')");
      expect(block).toMatch(/fanoutUserEntity\((req\.user!\.)?userId\)/);
      expect(block).not.toContain('fanoutUserEntity(req.params');
    }
    // Unmarking restores the member's searches, which a mark emptied of this person.
    const del = s.slice(s.indexOf("router.delete(\n  '/:userId/already-met'"));
    expect(del).toContain('recomputeAgentsForUser(userId)');
  });

  it('migration 134 makes the table the brief names, without transaction control', () => {
    const sql = readFileSync(join(__dirname, '../../../db/migrations/134_already_met.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS already_met/);
    expect(sql).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/target_user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/UNIQUE \(user_id, target_user_id\)/);
    expect(sql).toMatch(/CHECK \(user_id <> target_user_id\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_already_met_target ON already_met \(target_user_id\)/);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
  });
});
