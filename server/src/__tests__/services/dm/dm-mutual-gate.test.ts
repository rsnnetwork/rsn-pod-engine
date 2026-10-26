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
import { EVENT_FORMAT_KEYS, liveKindOf } from '@rsn/shared';

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

// ─── X2 (26 Oct 2026): taking part in the same completed meeting counts as having met ─────────────────────
//
// Fix round 1 (26 Oct): only a meeting-format event counts (the formats whose live kind is 'meeting' in
// @rsn/shared: a video meeting, a voice meeting, a webinar), and only an explicit "no" stands in its way:
// either person's latest rating of the other saying they do not want to meet again. A pair matched in speed
// networking and never rated has an encounter row that reads "not mutual" only by default
// (mutual_meet_again is NOT NULL DEFAULT FALSE), and is treated like strangers who shared the meeting.

describe('canMessage() — people who took part in the same completed meeting', () => {
  const ME = 'a0000000-0000-4000-8000-000000000001';
  const THEM = 'b0000000-0000-4000-8000-000000000002';
  const MEETING_FORMATS = EVENT_FORMAT_KEYS.filter((f) => liveKindOf(f) === 'meeting');

  /** canMessage's body, ending at the first closing brace on a line of its own, whatever the line ending. */
  const body = (() => {
    const start = src.indexOf('export async function canMessage(');
    const end = src.slice(start).search(/\r?\n\}\r?\n/);
    return src.slice(start, start + end);
  })();
  const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');
  const TOGETHER = /FROM session_participants a JOIN session_participants b ON b\.session_id = a\.session_id/;
  const SAID_NO = /FROM ratings r/;
  const asked = (re: RegExp) => mockQuery.mock.calls.find((c) => re.test(flat(c[0])));

  /**
   * The stand-in database: the user's role, whether a thread has messages, the encounter row, the format of a
   * completed event both joined (none when absent), and whether either person's latest rating of the other
   * says no. The shared-event read finds the event only when its format is among the formats the code asks
   * about, as the SQL's `= ANY($3::text[])` would.
   */
  function db(opts: {
    role?: string; messages?: number; encounter?: { mutual_meet_again: boolean } | null;
    sharedEvent?: string; latestNo?: boolean;
  }) {
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = flat(sql);
      if (/FROM users WHERE id/.test(text)) return { rows: [{ role: opts.role ?? 'member' }] };
      if (/FROM dm_conversations c JOIN direct_messages/.test(text)) return { rows: [{ msg_count: String(opts.messages ?? 0) }] };
      if (/FROM encounter_history/.test(text)) return { rows: opts.encounter ? [opts.encounter] : [] };
      if (TOGETHER.test(text)) {
        const formats = (params[2] ?? []) as string[];
        return { rows: opts.sharedEvent && formats.includes(opts.sharedEvent) ? [{ '?column?': 1 }] : [] };
      }
      if (SAID_NO.test(text)) return { rows: opts.latestNo ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    });
  }

  beforeEach(() => {
    mockQuery.mockReset();
    mockAreBlocked.mockReset();
    mockAreBlocked.mockResolvedValue(false);
  });

  it('the formats that count are exactly the meeting formats of the shared definition', () => {
    expect([...MEETING_FORMATS].sort()).toEqual(['video_meeting', 'voice_meeting', 'webinar']);
    expect(MEETING_FORMATS).not.toContain('speed_networking');
    expect(MEETING_FORMATS).not.toContain('physical_event');
  });

  it.each(['video_meeting', 'voice_meeting'])('two people who both joined the same completed %s, with no encounter row, may write to each other', async (format) => {
    db({ encounter: null, sharedEvent: format });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: true });
  });

  it.each(['speed_networking', 'physical_event'])('a completed %s event is not a meeting: two of its people with no encounter row still get no_encounter', async (format) => {
    db({ encounter: null, sharedEvent: format });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'no_encounter' });
  });

  it('asks whether both joined (not only registered), neither was removed, and the event is a completed meeting, by the shared list', async () => {
    db({ encounter: null, sharedEvent: 'video_meeting' });
    await canMessage(ME, THEM);
    const call = asked(TOGETHER)!;
    const sql = flat(call[0]);
    expect(sql).toMatch(/a\.user_id = \$1 AND b\.user_id = \$2/);
    expect(sql).toMatch(/a\.joined_at IS NOT NULL AND b\.joined_at IS NOT NULL/);
    expect(sql).toMatch(/a\.status <> 'removed' AND b\.status <> 'removed'/);
    expect(sql).toMatch(/JOIN sessions s ON s\.id = a\.session_id/);
    expect(sql).toMatch(/s\.status = 'completed'/);
    expect(sql).toMatch(/s\.event_format = ANY\(\$3::text\[\]\)/);
    expect(call[1]).toEqual([ME, THEM, MEETING_FORMATS]);
  });

  it('a pair matched but never rated (their encounter row says not mutual only by default) who shared a meeting may write', async () => {
    db({ encounter: { mutual_meet_again: false }, sharedEvent: 'video_meeting', latestNo: false });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: true });
  });

  it('an explicit no in either person\'s latest rating of the other still refuses, shared meeting or not', async () => {
    db({ encounter: { mutual_meet_again: false }, sharedEvent: 'video_meeting', latestNo: true });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'not_mutual' });
  });

  it('reads the "no" from the ratings: each person\'s latest rating of the other, in both directions', async () => {
    db({ encounter: { mutual_meet_again: false }, sharedEvent: 'video_meeting' });
    await canMessage(ME, THEM);
    const call = asked(SAID_NO)!;
    const sql = flat(call[0]);
    expect(sql).toMatch(/SELECT DISTINCT ON \(r\.from_user_id\) r\.meet_again FROM ratings r/);
    expect(sql).toMatch(/WHERE \(r\.from_user_id = \$1 AND r\.to_user_id = \$2\) OR \(r\.from_user_id = \$2 AND r\.to_user_id = \$1\)/);
    expect(sql).toMatch(/ORDER BY r\.from_user_id, r\.created_at DESC, r\.id DESC/);
    expect(sql).toMatch(/WHERE latest\.meet_again = FALSE/);
    expect(call[1]).toEqual([ME, THEM]);
  });

  it('with no shared meeting, a pair that is not mutual is still not_mutual, and strangers still get no_encounter, without reading ratings', async () => {
    db({ encounter: { mutual_meet_again: false } });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'not_mutual' });
    db({ encounter: null });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'no_encounter' });
    expect(asked(SAID_NO)).toBeUndefined();
  });

  it('a mutual encounter needs no shared meeting', async () => {
    db({ encounter: { mutual_meet_again: true } });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: true });
    expect(asked(TOGETHER)).toBeUndefined();
  });

  it('a block still wins over everything', async () => {
    mockAreBlocked.mockResolvedValue(true);
    db({ encounter: null, sharedEvent: 'video_meeting' });
    expect(await canMessage(ME, THEM)).toEqual({ allowed: false, reason: 'blocked' });
  });

  it('is asked after the encounter read and its mutual check, before either refusal', () => {
    const together = body.search(/FROM session_participants a/);
    const mutualCheck = body.search(/encounter\?\.mutual_meet_again/);
    expect(mutualCheck).toBeGreaterThan(-1);
    expect(together).toBeGreaterThan(body.indexOf('FROM encounter_history'));
    expect(together).toBeGreaterThan(mutualCheck);
    expect(together).toBeLessThan(body.search(/reason:\s*['"]not_mutual['"]/));
    expect(together).toBeLessThan(body.search(/reason:\s*['"]no_encounter['"]/));
  });
});
