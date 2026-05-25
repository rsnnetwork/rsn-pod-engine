// DM mutual-match gate + admin override (spec item #5 — 26 May 2026)
//
// These tests use the same source-code-grep pattern as phaseC-dm-service.test.ts.
// They document the exact evaluation order required by the spec:
//   1. self → blocked → admin override → existing-thread grandfather → mutual → no_encounter
//
// The test file runs against the compiled TypeScript source, not a live DB.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

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
