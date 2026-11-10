// 10 Nov 2026, spec item 5: For You stops introducing people the member already talks to.
// The candidate query is asserted as SQL text, the way platform-match.test.ts does.

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/poke/poke.service', () => ({ sendPoke: jest.fn(), __esModule: true }));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));

import { getPlatformMatches, notAlreadyInTouchSql } from '../../../services/matching/platform-match.service';

const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('notAlreadyInTouchSql', () => {
  const sql = squash(notAlreadyInTouchSql('$1', 'u'));

  it('excludes anyone with a dm_conversations row for the pair, whichever side deleted it', () => {
    expect(sql).toContain('FROM dm_conversations dmc');
    // The pair is stored with user_a_id < user_b_id, so it is looked up as LEAST / GREATEST.
    expect(sql).toContain('dmc.user_a_id = LEAST($1, u.id) AND dmc.user_b_id = GREATEST($1, u.id)');
    expect(sql).not.toMatch(/deleted_at/);
  });

  it('excludes an accepted request in either direction', () => {
    expect(sql).toContain("ap.status = 'accepted'");
    expect(sql).toContain('(ap.sender_id = $1 AND ap.recipient_id = u.id)');
    expect(sql).toContain('(ap.sender_id = u.id AND ap.recipient_id = $1)');
  });

  it('keeps an encounter-only person excluded, and lets only a PENDING request (either direction) override it', () => {
    expect(sql).toContain('FROM encounter_history e');
    expect(sql).toContain('e.user_a_id = LEAST($1, u.id) AND e.user_b_id = GREATEST($1, u.id)');
    expect(sql).toContain("pp.status = 'pending'");
    expect(sql).toContain('(pp.sender_id = $1 AND pp.recipient_id = u.id)');
    expect(sql).toContain('(pp.sender_id = u.id AND pp.recipient_id = $1)');
    // The old override was "any non-declined request", which kept accepted people on the page.
    expect(sql).not.toMatch(/<> 'declined'/);
  });

  it('is a bare boolean expression (no leading AND) built from the given member param and alias', () => {
    const other = squash(notAlreadyInTouchSql('$7', 'x'));
    expect(other.trimStart().startsWith('(')).toBe(true);
    expect(other).not.toMatch(/^\s*AND/);
    expect(other).toContain('LEAST($7, x.id)');
    expect(other).not.toContain('u.id');
    expect(other).not.toContain('$1');
  });
});

describe('For You candidate query', () => {
  it('applies the shared exclusion and still has no "accepted keeps them" override', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM users u WHERE u\.id = \$1/.test(sql)) {
        return { rows: [{ id: 'u-me', displayName: 'Me', onboardingCompleted: true }] };
      }
      return { rows: [] };
    });
    await getPlatformMatches('u-me');
    const candidateSql = squash(
      mockQuery.mock.calls.map(c => c[0] as string).find(s => /u\.id <> \$1/.test(s))!,
    );
    expect(candidateSql).toContain(squash(notAlreadyInTouchSql('$1', 'u')));
    expect(candidateSql).toContain("p.status = 'declined'");
    expect(candidateSql).toContain('FROM user_blocks b');
    expect(candidateSql).not.toMatch(/ip\.status <> 'declined'/);
  });
});
