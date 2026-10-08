// ─── The Matches page hears about event changes ──────────────────────────────
// (8 Oct 2026)
//
// The page shows the member's matches and, under them, the next RSN event to join. Release 6's server
// announces user:<id>:sessions to everyone who sees an event whenever it is created, renamed,
// rescheduled, cancelled or deleted (pinned in routes/session-event-list-fanout.test.ts), but the page's
// query declared only the member and their invites, so a changed event stayed as it was until a reload.
// The client has no test runner of its own, so, like the other files here, this reads the source and pins
// what the query declares, and that what it had before is still there.

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/matches/MatchesPage.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The entities the platformMatches query declares, as written, one entry each; and what it falls back to without a member. */
function declaredEntities(source: string): { entries: string[]; withoutMember: string } {
  const query = source.indexOf("queryKey: ['platformMatches', browse]");
  expect(query).toBeGreaterThanOrEqual(0);
  const meta = source.indexOf('meta: { entities:', query);
  expect(meta).toBeGreaterThan(query);
  const line = source.slice(meta, source.indexOf('\n', meta));
  const match = line.match(/entities: myUserId \? \[(.*)\] : (\[\]) \}/);
  expect(match).not.toBeNull();
  return { entries: match![1].split(',').map((entry) => entry.trim()).filter(Boolean), withoutMember: match![2] };
}

describe('the Matches page query', () => {
  const { entries, withoutMember } = declaredEntities(SOURCE);

  it('refreshes when an event changes: it names the member\'s sessions', () => {
    expect(entries).toContain('E.userSessions(myUserId)');
  });

  it('keeps what it already named: the member and their invites, which a meeting request changes', () => {
    expect(entries).toContain('E.user(myUserId)');
    expect(entries).toContain('E.userInvites(myUserId)');
  });

  it('names nothing else', () => {
    expect([...entries].sort()).toEqual(['E.user(myUserId)', 'E.userInvites(myUserId)', 'E.userSessions(myUserId)']);
  });

  it('still names nothing for a member who is not signed in yet', () => {
    expect(withoutMember).toBe('[]');
  });

  it('uses the shared entity helpers, so the tag it names is the one the server sends', () => {
    expect(SOURCE).toMatch(/import \{ E \} from '@\/realtime\/entities';/);
    const clientEntities = fs.readFileSync(path.join(__dirname, '../../../../client/src/realtime/entities.ts'), 'utf8');
    const serverEntities = fs.readFileSync(path.join(__dirname, '../../realtime/entities.ts'), 'utf8');
    const helper = /userSessions: \(userId: string\) => `user:\$\{userId\}:sessions`,/;
    expect(clientEntities).toMatch(helper);
    expect(serverEntities).toMatch(helper);
  });
});
