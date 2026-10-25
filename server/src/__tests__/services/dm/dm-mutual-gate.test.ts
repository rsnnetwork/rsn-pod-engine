// DM mutual-match gate + admin override (spec item #5 — 26 May 2026)
//
// These tests use the same source-code-grep pattern as phaseC-dm-service.test.ts.
// They document the exact evaluation order required by the spec:
//   1. self → blocked → admin override → existing-thread grandfather → mutual → no_encounter
//
// The test file runs against the compiled TypeScript source, not a live DB.
//
// 26 Oct 2026 (X2): two people who both took part in the same completed event count as having met, so
// people who were in a video meeting together (which makes no match, so no encounter row) can write to
// each other one to one. The last block below calls canMessage against a stand-in database.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockAreBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({
  areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
  __esModule: true,
}));

import * as nodeFs from 'fs';
import * as nodePath from 'path';
import { canMessage } from '../../../services/dm/dm.service';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

const src = readServer('services/dm/dm.service.ts');
const routeSrc = readServer('routes/dm.ts');

// ─── Helpers to slice the canMessage function body ────────────────────────────

function sliceCanMessage(source: string): string {
  const fnStart = source.indexOf('export async function canMessage(');
  // find the closing brace by looking for a standalone `}` after the opening
  const fnEnd = source.indexOf('\n}\n', fnStart);
  return source.slice(fnStart, fnEnd);
}

function sliceSendMessage(source: string): string {
  const fnStart = source.indexOf('export async function sendMessage(');
  const fnEnd = source.indexOf('\n}\n', fnStart);
  return source.slice(fnStart, fnEnd);
}

// ─── canMessage evaluation order ─────────────────────────────────────────────

describe('canMessage() — mutual-match gate + admin override', () => {
  const fn = sliceCanMessage(src);

  it('still rejects self-DM with reason="self" (invariant unchanged)', () => {
    expect(fn).toMatch(/reason:\s*['"]self['"]/);
  });

  it('still rejects blocked users with reason="blocked" (invariant unchanged)', () => {
    expect(fn).toMatch(/reason:\s*['"]blocked['"]/);
  });

  // Step 3 — admin override: reads role from DB (users table), never from client
  it('reads the from-user role from the DB (users table query)', () => {
    expect(fn).toMatch(/SELECT[\s\S]+?role[\s\S]+?FROM users WHERE id/);
  });

  it('returns allowed:true immediately for admin role (no mutual/encounter needed)', () => {
    expect(fn).toMatch(/admin/);
    // The function must short-circuit with allowed:true for admin/super_admin
    expect(fn).toMatch(/allowed:\s*true/);
  });

  it('allows both "admin" and "super_admin" roles to bypass the gate', () => {
    // Both enum values must be checked
    expect(fn).toMatch(/['"]admin['"]/);
    expect(fn).toMatch(/['"]super_admin['"]/);
  });

  // Step 4 — forward-only grandfather: existing thread with messages passes
  it('checks for an existing conversation with at least one message (grandfather)', () => {
    // Must query dm_conversations joined to or correlated with direct_messages count
    expect(fn).toMatch(/dm_conversations/);
    expect(fn).toMatch(/direct_messages/);
  });

  it('returns allowed:true when an existing-thread-with-messages is found (grandfather)', () => {
    // This must be a path that returns {allowed:true} without needing mutual
    expect(fn).toMatch(/allowed:\s*true/);
  });

  // Step 5 — mutual gate: encounter_history.mutual_meet_again must be checked
  it('queries encounter_history for mutual_meet_again = TRUE', () => {
    expect(fn).toMatch(/mutual_meet_again/);
  });

  it('returns allowed:true when mutual_meet_again is TRUE', () => {
    expect(fn).toMatch(/allowed:\s*true/);
  });

  it('returns reason="not_mutual" when encounter exists but mutual_meet_again is false', () => {
    expect(fn).toMatch(/reason:\s*['"]not_mutual['"]/);
  });

  it('still returns reason="no_encounter" when no encounter row exists (final fallback)', () => {
    expect(fn).toMatch(/reason:\s*['"]no_encounter['"]/);
  });

  // Ordering: admin check must come BEFORE mutual check (which itself precedes no_encounter)
  it('admin override check appears before the mutual_meet_again check', () => {
    const adminIdx = fn.indexOf('admin');
    const mutualIdx = fn.indexOf('mutual_meet_again');
    expect(adminIdx).toBeGreaterThan(-1);
    expect(mutualIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeLessThan(mutualIdx);
  });

  it('grandfather check appears before the mutual_meet_again check', () => {
    // The thread-with-messages grandfather must be evaluated before the mutual gate
    const grandfatherIdx = fn.indexOf('direct_messages');
    const mutualIdx = fn.indexOf('mutual_meet_again');
    expect(grandfatherIdx).toBeGreaterThan(-1);
    expect(mutualIdx).toBeGreaterThan(-1);
    expect(grandfatherIdx).toBeLessThan(mutualIdx);
  });

  it('block check appears before the admin override check (cheapest rejection first)', () => {
    const blockIdx = fn.indexOf('areBlocked');
    const adminIdx = fn.indexOf('FROM users WHERE id');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(adminIdx);
  });
});

// ─── sendMessage re-check ─────────────────────────────────────────────────────

describe('sendMessage() — gate re-checked on every send', () => {
  const fn = sliceSendMessage(src);

  it('calls canMessage() server-side so the gate enforces on every send', () => {
    expect(fn).toMatch(/canMessage\(/);
  });

  it('maps not_mutual reason to a user-facing error message', () => {
    expect(fn).toMatch(/not_mutual/);
  });

  it('not_mutual user-facing message references "meet again"', () => {
    // The error shown to the user must explain the mutual requirement clearly
    expect(fn).toMatch(/meet again/i);
  });
});

// ─── Route — can-message response ─────────────────────────────────────────────

describe('routes/dm.ts — can-message endpoint response', () => {
  it('GET /can-message/:userId still exists', () => {
    expect(routeSrc).toMatch(/router\.get\(\s*['"]\/can-message\/:userId['"]/);
  });
});

// ─── Architectural invariants (must not regress) ──────────────────────────────

describe('canMessage() — existing invariants still hold', () => {
  const fn = sliceCanMessage(src);

  it('self check is still the very first thing in canMessage()', () => {
    const selfReasonIdx = fn.indexOf('"self"') !== -1 ? fn.indexOf('"self"') : fn.indexOf("'self'");
    // self check fires before any DB call
    const firstQueryIdx = fn.indexOf('await ');
    expect(selfReasonIdx).toBeLessThan(firstQueryIdx);
  });
});

// ─── X2 (26 Oct 2026): taking part in the same completed event counts as having met ─────────────────────

describe('canMessage() — people who took part in the same completed event', () => {
  const ME = 'a0000000-0000-4000-8000-000000000001';
  const THEM = 'b0000000-0000-4000-8000-000000000002';

  /** canMessage's body, ending at the first closing brace on a line of its own, whatever the line ending. */
  const body = (() => {
    const start = src.indexOf('export async function canMessage(');
    const end = src.slice(start).search(/\r?\n\}\r?\n/);
    return src.slice(start, start + end);
  })();
  const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');
  const TOGETHER = /FROM session_participants a JOIN session_participants b ON b\.session_id = a\.session_id/;

  /** The stand-in database: the user's role, whether a thread has messages, the encounter row, a shared event. */
  function db(opts: { role?: string; messages?: number; encounter?: { mutual_meet_again: boolean } | null; together?: boolean }) {
    mockQuery.mockImplementation(async (sql: string) => {
      const text = flat(sql);
      if (/FROM users WHERE id/.test(text)) return { rows: [{ role: opts.role ?? 'member' }] };
      if (/FROM dm_conversations c JOIN direct_messages/.test(text)) return { rows: [{ msg_count: String(opts.messages ?? 0) }] };
      if (/FROM encounter_history/.test(text)) return { rows: opts.encounter ? [opts.encounter] : [] };
      if (TOGETHER.test(text)) return { rows: opts.together ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    });
  }

  beforeEach(() => {
    mockQuery.mockReset();
    mockAreBlocked.mockReset();
    mockAreBlocked.mockResolvedValue(false);
  });

  it('two people who both joined the same completed event, with no encounter row, may write to each other', async () => {
    db({ encounter: null, together: true });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: true });
  });

  it('asks whether both joined (not only registered), neither was removed, and the event is completed', async () => {
    db({ encounter: null, together: true });
    await canMessage(ME, THEM);
    const call = mockQuery.mock.calls.find((c) => TOGETHER.test(flat(c[0])))!;
    const sql = flat(call[0]);
    expect(sql).toMatch(/a\.user_id = \$1 AND b\.user_id = \$2/);
    expect(sql).toMatch(/a\.joined_at IS NOT NULL AND b\.joined_at IS NOT NULL/);
    expect(sql).toMatch(/a\.status <> 'removed' AND b\.status <> 'removed'/);
    expect(sql).toMatch(/JOIN sessions s ON s\.id = a\.session_id/);
    expect(sql).toMatch(/s\.status = 'completed'/);
    expect(call[1]).toEqual([ME, THEM]);
  });

  it('without a shared completed event (one of them only registered, say) the answer is still no_encounter', async () => {
    db({ encounter: null, together: false });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'no_encounter' });
  });

  it('an encounter where one of them said no to meeting again still wins: attending the event does not override it', async () => {
    db({ encounter: { mutual_meet_again: false }, together: true });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'not_mutual' });
    expect(mockQuery.mock.calls.some((c) => TOGETHER.test(flat(c[0])))).toBe(false);
  });

  it('a block still wins over everything', async () => {
    mockAreBlocked.mockResolvedValue(true);
    db({ encounter: null, together: true });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'blocked' });
  });

  it('is asked only once the encounter row is known to be missing: after reading it, before answering no_encounter', () => {
    const together = body.search(/FROM session_participants a/);
    expect(together).toBeGreaterThan(body.indexOf('FROM encounter_history'));
    expect(together).toBeGreaterThan(body.search(/encounterResult\.rows\.length === 0/));
    expect(together).toBeLessThan(body.search(/reason:\s*['"]no_encounter['"]/));
  });
});
