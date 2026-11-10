// server/src/__tests__/services/user/search-request-state.test.ts
// 10 Nov 2026 (Stefan: "if I have ALREADY asked them, why is that not shown?"). Find people kept "sent" only in the
// page's memory, so a reload offered "I want to meet" again for someone already asked. Each result now carries where
// a meeting request between the two stands, from the server, in For You's shape: pokeStatus 'pending' | 'accepted' |
// null and pokeSentByOwner. A withdrawn request (cancelled) is as if never sent.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: (c: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { searchMembers } from '../../../services/user/user-search.service';

const ME = 'me-0000';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Req { sender: string; recipient: string; status: string; at: number }

/**
 * Answers the search as Postgres would for the request part: the person's newest request with the searcher, either
 * way, among those the SQL's own status filter keeps, and pokeSentByOwner as the SQL's CASE computes it.
 */
function armWith(people: string[], requests: Req[]) {
  mockQuery.mockImplementation((sqlIn: string, params: unknown[]) => {
    const sql = flat(sqlIn);
    const keep = /p\.status IN \('pending', 'accepted'\)/.test(sql) ? ['pending', 'accepted'] : null;
    const viewer = params[0];
    return Promise.resolve({
      rows: people.map((id) => {
        const newest = requests
          .filter(r => (r.sender === viewer && r.recipient === id) || (r.sender === id && r.recipient === viewer))
          .filter(r => !keep || keep.includes(r.status))
          .sort((x, y) => y.at - x.at)[0];
        return {
          userId: id, displayName: id, avatarUrl: null, jobTitle: null, company: null, location: null,
          pokeStatus: newest?.status ?? null,
          pokeSentByOwner: newest ? newest.sender === viewer : null,
          // The SQL's EXISTS: a declined request the searcher sent this person, at any time.
          declinedByThem: /d\.sender_id = \$1 AND d\.recipient_id = u\.id AND d\.status = 'declined'/.test(sql)
            && requests.some(r => r.sender === viewer && r.recipient === id && r.status === 'declined'),
        };
      }),
    });
  });
}

const byId = async (q = 'ann') => Object.fromEntries((await searchMembers(ME, q, 20)).map(r => [r.userId, r]));

beforeEach(() => mockQuery.mockReset());

describe('Find people carries where a meeting request stands', () => {
  it('reads the newest request between the two, either way, pending or accepted only', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await searchMembers(ME, 'ann', 20);
    const sql = flat(String(mockQuery.mock.calls[0][0]));
    expect(sql).toContain(
      'LEFT JOIN LATERAL ( SELECT p.status, p.sender_id FROM user_pokes p WHERE p.status IN (\'pending\', \'accepted\') '
      + 'AND ((p.sender_id = $1 AND p.recipient_id = u.id) OR (p.sender_id = u.id AND p.recipient_id = $1)) '
      + 'ORDER BY p.created_at DESC LIMIT 1 ) pk ON TRUE');
    expect(sql).toContain('pk.status AS "pokeStatus"');
    expect(sql).toContain('CASE WHEN pk.sender_id IS NULL THEN NULL ELSE pk.sender_id = $1 END AS "pokeSentByOwner"');
  });

  it('says "sent by me" for my waiting request, and "sent to me" for theirs: both directions', async () => {
    armWith(['ann', 'ben'], [
      { sender: ME, recipient: 'ann', status: 'pending', at: 1 },
      { sender: 'ben', recipient: ME, status: 'pending', at: 1 },
    ]);
    const r = await byId();
    expect(r.ann).toMatchObject({ pokeStatus: 'pending', pokeSentByOwner: true });
    expect(r.ben).toMatchObject({ pokeStatus: 'pending', pokeSentByOwner: false });
  });

  it('an accepted request, either way, reads accepted', async () => {
    armWith(['ann', 'ben'], [
      { sender: ME, recipient: 'ann', status: 'accepted', at: 1 },
      { sender: 'ben', recipient: ME, status: 'accepted', at: 1 },
    ]);
    const r = await byId();
    expect(r.ann).toMatchObject({ pokeStatus: 'accepted', pokeSentByOwner: true });
    expect(r.ben).toMatchObject({ pokeStatus: 'accepted', pokeSentByOwner: false });
  });

  it('a withdrawn request is no request: the person is fresh again, whichever way it went', async () => {
    armWith(['ann', 'ben'], [
      { sender: ME, recipient: 'ann', status: 'cancelled', at: 1 },
      { sender: 'ben', recipient: ME, status: 'cancelled', at: 1 },
    ]);
    const r = await byId();
    expect(r.ann).toMatchObject({ pokeStatus: null, pokeSentByOwner: null });
    expect(r.ben).toMatchObject({ pokeStatus: null, pokeSentByOwner: null });
  });

  it('an existing row: an old accepted request stands behind a newer withdrawn one', async () => {
    armWith(['ann'], [
      { sender: 'ann', recipient: ME, status: 'accepted', at: 1 },
      { sender: ME, recipient: 'ann', status: 'cancelled', at: 2 },
    ]);
    expect((await byId()).ann).toMatchObject({ pokeStatus: 'accepted', pokeSentByOwner: false });
  });

  it('a withdrawn request then asked again reads as sent', async () => {
    armWith(['ann'], [
      { sender: ME, recipient: 'ann', status: 'cancelled', at: 1 },
      { sender: ME, recipient: 'ann', status: 'pending', at: 2 },
    ]);
    expect((await byId()).ann).toMatchObject({ pokeStatus: 'pending', pokeSentByOwner: true });
  });

  it('nobody asked anybody: null and null', async () => {
    armWith(['ann'], []);
    expect((await byId()).ann).toMatchObject({ pokeStatus: null, pokeSentByOwner: null, declinedByThem: false });
  });
});

// Controller ruling, fix round 1 (spec 09/04: consistent declined states on Find People). sendPoke refuses to ask
// someone who declined the member's earlier request, so the card must say "Request declined" rather than offer a
// button that can only fail. The rule and precedence are the Everyone list's (F3, commit f45f0dec).
describe('Find people carries a declined request, Everyone\'s way', () => {
  it('reads the decline from requests the searcher SENT that this member declined, at any time', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await searchMembers(ME, 'ann', 20);
    const sql = flat(String(mockQuery.mock.calls[0][0]));
    expect(sql).toContain(
      "EXISTS (SELECT 1 FROM user_pokes d WHERE d.sender_id = $1 AND d.recipient_id = u.id AND d.status = 'declined') AS \"declinedByThem\"");
  });

  it('my request they declined: declinedByThem, and no live request', async () => {
    armWith(['ann'], [{ sender: ME, recipient: 'ann', status: 'declined', at: 1 }]);
    expect((await byId()).ann).toMatchObject({ pokeStatus: null, pokeSentByOwner: null, declinedByThem: true });
  });

  it('their request I declined: nothing, so I can still ask (the one who declined is never refused)', async () => {
    armWith(['ann'], [{ sender: 'ann', recipient: ME, status: 'declined', at: 1 }]);
    expect((await byId()).ann).toMatchObject({ pokeStatus: null, declinedByThem: false });
  });

  it('a live request outranks an old decline: they asked me after declining me (pressing is the match)', async () => {
    armWith(['ann'], [
      { sender: ME, recipient: 'ann', status: 'declined', at: 1 },
      { sender: 'ann', recipient: ME, status: 'pending', at: 2 },
    ]);
    expect((await byId()).ann).toMatchObject({ pokeStatus: 'pending', pokeSentByOwner: false, declinedByThem: true });
  });

  it('a connection outranks an old decline: they declined once, later I accepted their request', async () => {
    armWith(['ann'], [
      { sender: ME, recipient: 'ann', status: 'declined', at: 1 },
      { sender: 'ann', recipient: ME, status: 'accepted', at: 2 },
    ]);
    expect((await byId()).ann).toMatchObject({ pokeStatus: 'accepted', declinedByThem: true });
  });

  it('the card picks the state with that precedence: sent, connected, then declined, else the button', () => {
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');
    const page = flat(fs.readFileSync(path.join(__dirname, '../../../../../client/src/features/search/SearchPage.tsx'), 'utf8'));
    expect(page).toContain("const declinedForMe = (r: Result) => r.declinedByThem === true && !r.pokeStatus;");
    expect(page).toMatch(/askedByMe\(r\) \? \(.*\) : r\.pokeStatus === 'accepted' \? \(.*\) : declinedForMe\(r\) \? \(.*Request declined.*\) : \(.*I want to meet/);
  });

  it('still never returns the searcher, and keeps the thin card (no email)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await searchMembers(ME, 'ann', 20);
    const sql = flat(String(mockQuery.mock.calls[0][0]));
    expect(sql).toMatch(/u\.id <> \$1/);
    expect(sql).not.toMatch(/u\.email/);
  });
});
