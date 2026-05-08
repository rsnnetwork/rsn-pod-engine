// ─── Phase 8A — Stefan's 8 May review, server data-integrity fixes ─────────
//
// Architectural pins for the five server-side items:
//   8A.1  Invite acceptance returns authoritative participantStatus on the
//         idempotent path (no more "Failed to accept invite" lie).
//   8A.2  Pre-event planning filters by presence (Wazim case — registered
//         but never connected was getting into the schedule).
//   8A.3  Matching validator hardens against self-match + opts callers
//         into sessionWideActiveCheck for force-match.
//   8A.4  Chat scope tightened — fallback room query excludes
//         completed / reassigned matches; room messages always carry
//         a roomId.
//   8A.5  Cohost-change triggers repairFutureRounds so the pre-plan
//         re-shapes immediately when someone is promoted/demoted
//         mid-event.

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..');
const SERVER = join(REPO, 'server', 'src');

const INVITE_SVC = join(SERVER, 'services', 'invite', 'invite.service.ts');
const INVITE_PAGE = join(REPO, 'client', 'src', 'features', 'invites', 'InviteAcceptPage.tsx');
const MATCHING_SVC = join(SERVER, 'services', 'matching', 'matching.service.ts');
const MATCHING_FLOW = join(SERVER, 'services', 'orchestration', 'handlers', 'matching-flow.ts');
const HOST_ACTIONS = join(SERVER, 'services', 'orchestration', 'handlers', 'host-actions.ts');
const VALIDATOR = join(SERVER, 'services', 'matching', 'match-validator.service.ts');
const CHAT_HANDLERS = join(SERVER, 'services', 'orchestration', 'handlers', 'chat-handlers.ts');

describe('Phase 8A — Stefan 8 May server fixes (architectural pins)', () => {
  // ── 8A.1 ────────────────────────────────────────────────────────────────
  describe('8A.1 — invite idempotent participantStatus is never undefined', () => {
    test('server defaults participantStatus on the idempotent path', () => {
      const src = readFileSync(INVITE_SVC, 'utf8');
      // Look for the idempotent SELECT result handling — must default
      // when the row is missing instead of leaving undefined.
      expect(src).toMatch(/participantStatusIdempotent\s*=[\s\S]{0,200}\?\?\s*['"]registered['"]|participantStatusIdempotent\s*=[\s\S]{0,200}\|\|\s*['"]registered['"]/);
    });

    test('client trusts a 200 response — no false-negative throw on missing pStatus', () => {
      const src = readFileSync(INVITE_PAGE, 'utf8');
      // Either the throw is removed, or it's gated to non-success responses only.
      // Pin: the literal `if (sid && !pStatus)` raw throw is gone.
      expect(src).not.toMatch(/if\s*\(\s*sid\s*&&\s*!pStatus\s*\)\s*\{\s*throw new Error/);
    });
  });

  // ── 8A.2 ────────────────────────────────────────────────────────────────
  describe('8A.2 — pre-plan filters by presence (Wazim case)', () => {
    test('generateSessionSchedule accepts a presentUserIds parameter', () => {
      const src = readFileSync(MATCHING_SVC, 'utf8');
      // The function signature should include presentUserIds, similar to
      // generateSingleRound which already has this argument.
      expect(src).toMatch(/generateSessionSchedule[\s\S]{0,400}presentUserIds/);
    });

    test('handleHostStart passes presentUserIds to generateSessionSchedule', () => {
      const src = readFileSync(HOST_ACTIONS, 'utf8');
      // Caller computes presence from activeSession.presenceMap and
      // passes it into generateSessionSchedule. Allow either order.
      expect(src).toMatch(/presenceMap[\s\S]{0,500}generateSessionSchedule|generateSessionSchedule[\s\S]{0,500}presenceMap/);
    });

    test('dashboard surfaces both registered count and present count separately', () => {
      const src = readFileSync(MATCHING_FLOW, 'utf8');
      // Either a new field or a renamed pair on the host:round_dashboard
      // emit. Look for either presentMainRoomCount or presentCount.
      expect(src).toMatch(/presentMainRoomCount|presentCount|connectedMainRoomCount/);
    });
  });

  // ── 8A.3 ────────────────────────────────────────────────────────────────
  describe('8A.3 — matching validator hardening', () => {
    test('validator rejects self-match explicitly (no relying on schema CHECK)', () => {
      const src = readFileSync(VALIDATOR, 'utf8');
      expect(src).toMatch(/participantAId\s*===\s*participantBId|participantBId\s*===\s*participantAId|cannot be matched with themselves|self.?match/i);
    });

    test('host:force_match enables sessionWideActiveCheck', () => {
      // The force-match handler lives in matching-flow.ts (not host-actions).
      const src = readFileSync(MATCHING_FLOW, 'utf8');
      expect(src).toMatch(/handleHostForceMatch[\s\S]{0,2000}sessionWideActiveCheck\s*:\s*true/);
    });
  });

  // ── 8A.4 ────────────────────────────────────────────────────────────────
  describe('8A.4 — chat scope tighter', () => {
    test('room-scope fallback restricted to active / scheduled matches', () => {
      const src = readFileSync(CHAT_HANDLERS, 'utf8');
      // The fallback SQL must include status IN ('active', 'scheduled')
      // OR exclude completed/reassigned explicitly.
      expect(src).toMatch(/status\s+IN\s*\(\s*['"]active['"][\s\S]{0,80}['"]scheduled['"]\s*\)|status\s*=\s*['"]active['"]/);
    });

    test('room-scope messages always carry a roomId', () => {
      const src = readFileSync(CHAT_HANDLERS, 'utf8');
      // The fallback assigns roomId or guarantees a non-null value
      // for room scope messages.
      expect(src).toMatch(/roomId\s*=\s*resolvedRoomId\s*(\|\||\?\?)/);
    });
  });

  // ── 8A.5 ────────────────────────────────────────────────────────────────
  describe('8A.5 — cohost change triggers plan repair', () => {
    test('handleAssignCohost calls maybeRepairFutureRounds', () => {
      const src = readFileSync(HOST_ACTIONS, 'utf8');
      // Look inside handleAssignCohost for a repair call.
      const fnStart = src.indexOf('export async function handleAssignCohost');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSlice = src.slice(fnStart, fnStart + 4000);
      expect(fnSlice).toMatch(/maybeRepairFutureRounds|repairFutureRounds/);
    });

    test('handleRemoveCohost calls maybeRepairFutureRounds', () => {
      const src = readFileSync(HOST_ACTIONS, 'utf8');
      const fnStart = src.indexOf('export async function handleRemoveCohost');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSlice = src.slice(fnStart, fnStart + 4000);
      expect(fnSlice).toMatch(/maybeRepairFutureRounds|repairFutureRounds/);
    });
  });
});
