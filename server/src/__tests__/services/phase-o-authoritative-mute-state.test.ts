// Phase O — 12 May item 7: single authoritative audio/mute state.
//
// Stefan reported on 12 May that admins couldn't mute, participants
// couldn't unmute themselves, Shradha was stuck muted after a reconnect,
// and the audio state was inconsistent across clients. Root causes:
//   1. The mute gate accepted only the original event host
//      (activeSession.hostUserId === userId), so co-hosts and super_admin
//      hit "NOT_HOST" when they tried to mute someone.
//   2. The mute was a fire-and-forget socket relay (`lobby:mute_command`)
//      with NO persistent server-side state. On reconnect, the new socket
//      had no record of the mute — the user came back unmuted at the
//      LiveKit level, even though hosts thought they were muted.
//
// Phase O fixes both:
//   - Migration 061 adds `session_participants.host_muted BOOLEAN NOT NULL
//     DEFAULT FALSE` + `host_muted_at TIMESTAMPTZ`.
//   - handleHostMuteParticipant / handleHostMuteAll now go through
//     `verifyHost` (which calls canActAsHost — cohost + super_admin
//     accepted post-Phase-I; admin opt-in via Phase M also covered),
//     UPDATE the column transactionally before relaying.
//   - Snapshot exposes `hostMutedUserIds: string[]` so the client can
//     replay the mute on cold-start and reconnect.
//   - Client useSessionSocket reads the array on snapshot apply; if the
//     local user is in it, fires the existing hostMuteCommand pathway.
//
// What's NOT in Phase O (deferred): LiveKit permission integration to
// REVOKE `canPublishAudio` when host_muted=TRUE. Today the client respects
// the mute via UI; a malicious client could bypass by directly publishing.
// A future phase can add the LiveKit token reissue path.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase O — authoritative mute state (item 7)', () => {
  describe('Migration 061 — host_muted column on session_participants', () => {
    const sql = readServer('db/migrations/061_host_muted_state.sql');

    it('adds host_muted BOOLEAN NOT NULL DEFAULT FALSE (additive on live DB)', () => {
      expect(sql).toMatch(
        /ADD\s+COLUMN\s+host_muted\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      );
    });

    it('adds host_muted_at TIMESTAMPTZ for audit history', () => {
      expect(sql).toMatch(/host_muted_at\s+TIMESTAMPTZ/i);
    });

    it('wraps the change in a single transaction', () => {
      expect(sql).toMatch(/BEGIN;[\s\S]+COMMIT;/);
    });
  });

  describe('Server — handleHostMuteParticipant gate + persistence', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function handleHostMuteParticipant');
    const fnEnd = src.indexOf('\nexport ', fnStart + 1);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

    it('uses verifyHost (canActAsHost) gate — co-hosts + super_admin can mute', () => {
      // Phase O fix #1: the pre-fix gate `activeSession.hostUserId !== userId`
      // refused everyone except the original event host. The new gate goes
      // through verifyHost which delegates to canActAsHost.
      expect(fn).toMatch(/verifyHost\(socket,\s*data\.sessionId\)/);
      // Forbid the pre-fix narrow check explicitly so a future PR cannot
      // accidentally re-narrow.
      expect(fn).not.toMatch(/activeSession\.hostUserId\s*!==\s*userId/);
    });

    it('UPDATEs host_muted before relaying the lobby:mute_command', () => {
      expect(fn).toMatch(
        /UPDATE\s+session_participants[\s\S]{0,200}host_muted\s*=\s*TRUE/i,
      );
      // The unmute branch must clear the flag.
      expect(fn).toMatch(
        /UPDATE\s+session_participants[\s\S]{0,200}host_muted\s*=\s*FALSE/i,
      );
      // host_muted_at is set on flip-to-TRUE (audit trail).
      expect(fn).toMatch(/host_muted_at\s*=\s*NOW\(\)/);
    });

    it('still emits lobby:mute_command for immediate UX feedback', () => {
      expect(fn).toMatch(/emit\(\s*['"]lobby:mute_command['"]/);
    });
  });

  describe('Server — handleHostMuteAll gate + bulk persistence', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');
    const fnStart = src.indexOf('export async function handleHostMuteAll');
    const fnEnd = src.indexOf('\nexport ', fnStart + 1);
    const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

    it('uses verifyHost gate (consistency with handleHostMuteParticipant)', () => {
      expect(fn).toMatch(/verifyHost\(socket,\s*data\.sessionId\)/);
      expect(fn).not.toMatch(/activeSession\.hostUserId\s*!==\s*userId/);
    });

    it('persists in a single bulk UPDATE excluding hosts/cohosts (no N+1)', () => {
      // Pre-fix had no DB persistence at all; Phase O persists in ONE
      // UPDATE that excludes the host roster (getAllHostIds) and the
      // ghost statuses. Pin the shape so a future PR can't regress to
      // a per-user loop.
      expect(fn).toMatch(/getAllHostIds/);
      expect(fn).toMatch(
        /UPDATE\s+session_participants[\s\S]{0,400}user_id\s*!=\s*ALL\(\$2::uuid\[\]\)/i,
      );
      // Ghost-status guard.
      expect(fn).toMatch(/status\s+NOT\s+IN\s*\(\s*['"]removed['"]\s*,\s*['"]left['"]\s*,\s*['"]no_show['"]\s*\)/i);
    });

    it('still relays lobby:mute_command to each non-host participant', () => {
      expect(fn).toMatch(/emit\(\s*['"]lobby:mute_command['"]/);
      // The relay must skip the host roster (consistency with the DB
      // exclusion — host shouldn't be relayed a mute either).
      expect(fn).toMatch(/allHostIds\.includes\(participantId\)/);
    });
  });

  describe('Server — snapshot exposes hostMutedUserIds', () => {
    const src = readServer('services/session/session-state-snapshot.service.ts');

    it('SessionStateSnapshot interface declares hostMutedUserIds: string[]', () => {
      expect(src).toMatch(/hostMutedUserIds:\s*string\[\]/);
    });

    it('pulls host_muted on the existing session_participants SELECT (single round-trip)', () => {
      // Piggyback on the T1-4 registered count query — adds the column
      // to the SELECT and accumulates true-valued users into an array.
      expect(src).toMatch(/sp\.host_muted/);
      expect(src).toMatch(/hostMutedUserIds\.push\(r\.user_id\)/);
    });

    it('returned snapshot includes hostMutedUserIds at the top level', () => {
      const returnIdx = src.indexOf('return {');
      expect(returnIdx).toBeGreaterThan(-1);
      const returnSlice = src.slice(returnIdx, returnIdx + 1500);
      expect(returnSlice).toMatch(/hostMutedUserIds[,\s}]/);
    });
  });

  describe('Client — sessionStore exposes hostMutedUserIds set + setter', () => {
    const src = readClient('stores/sessionStore.ts');

    it('declares Set<string> field on the live state', () => {
      expect(src).toMatch(/hostMutedUserIds:\s*Set<string>/);
    });

    it('exposes setHostMutedUserIds that accepts an array of ids', () => {
      expect(src).toMatch(/setHostMutedUserIds:\s*\(ids: string\[\]\)/);
      // Implementation must wrap the array in a new Set so equality and
      // mutation are isolated from the snapshot.
      expect(src).toMatch(/setHostMutedUserIds:\s*\(ids\)\s*=>\s*set\(\{\s*hostMutedUserIds:\s*new Set\(ids\)/);
    });

    it('SessionStateSnapshot interface declares the optional array form', () => {
      expect(src).toMatch(/hostMutedUserIds\?\s*:\s*string\[\]/);
    });

    it('reset() clears hostMutedUserIds to a new empty Set', () => {
      expect(src).toMatch(/hostMutedUserIds:\s*new Set<string>\(\)/);
    });
  });

  describe('Client — useSessionSocket replays mute on snapshot apply', () => {
    const src = readClient('hooks/useSessionSocket.ts');

    it('imports useAuthStore so the local user id can be resolved', () => {
      expect(src).toMatch(/import\s+\{\s*useAuthStore\s*\}\s+from\s+['"]@\/stores\/authStore['"]/);
    });

    it('on session:state, applies hostMutedUserIds + fires hostMuteCommand when local user is in the set', () => {
      // The replay logic: when snapshot includes hostMutedUserIds and the
      // local user's id is in the array, set hostMuteCommand=true so the
      // LiveKit audio track is muted on reconnect. This closes the
      // pre-fix "Shradha stuck unmuted after reconnect" gap.
      expect(src).toMatch(/Array\.isArray\(data\.hostMutedUserIds\)/);
      expect(src).toMatch(/store\.setHostMutedUserIds\(data\.hostMutedUserIds\)/);
      expect(src).toMatch(
        /useAuthStore\.getState\(\)[\s\S]{0,80}data\.hostMutedUserIds\.includes\(myId\)[\s\S]{0,80}setHostMuteCommand\(true\)/,
      );
    });
  });
});
