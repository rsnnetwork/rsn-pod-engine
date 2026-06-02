// Phase U — Phase O follow-up. LiveKit-level publish-permission
// revocation so the host_muted DB flag is enforced at the SFU, not just
// in the client UI. A determined / modified client cannot bypass mute
// by publishing audio frames directly: LiveKit refuses to accept them.
//
// Approach:
//   • Add setParticipantCanPublishAudio(roomId, userId, bool) to
//     IVideoProvider.
//   • LiveKitProvider implements via RoomServiceClient.updateParticipant
//     with permission { canPublish: false } on revoke, true on restore.
//   • MockVideoProvider implements as a logged no-op (no media plane).
//   • host-actions.handleHostMuteParticipant and handleHostMuteAll
//     persist host_muted (Phase O), then call enforceLiveKitMute which
//     applies the permission on the lobby room AND any active match
//     room the user is in.
//   • Non-fatal failure: if LiveKit is down, the DB + socket relay
//     still happen; the enforcement is defence in depth, not the only
//     line of defence.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}

describe('Phase U — LiveKit canPublishAudio revocation', () => {
  describe('IVideoProvider interface contract', () => {
    const src = readServer('services/video/video.interface.ts');

    it('declares setParticipantCanPublishAudio with (roomId, userId, canPublishAudio)', () => {
      expect(src).toMatch(
        /setParticipantCanPublishAudio\(\s*roomId:\s*string,\s*userId:\s*string,\s*canPublishAudio:\s*boolean\s*\):\s*Promise<void>/,
      );
    });
  });

  describe('LiveKitProvider implementation', () => {
    const src = readServer('services/video/livekit.provider.ts');

    it('calls roomService.updateParticipant with a permission object', () => {
      const fnIdx = src.indexOf('setParticipantCanPublishAudio');
      expect(fnIdx).toBeGreaterThan(-1);
      // Window widened for the long explanatory comment block.
      const block = src.slice(fnIdx, fnIdx + 3000);
      expect(block).toMatch(/this\.roomService\.updateParticipant\(/);
      // Bug 1 fix — canPublish stays TRUE; the mute is enforced via
      // canPublishSources whitelist so camera + screen-share stay live.
      expect(block).toMatch(/canPublish:\s*true/);
      expect(block).toMatch(/canPublishSources/);
    });

    it('swallows "not found" / Twirp code 5 — participant not in room is non-fatal', () => {
      const fnIdx = src.indexOf('setParticipantCanPublishAudio');
      const block = src.slice(fnIdx, fnIdx + 3000);
      expect(block).toMatch(/code\s*===\s*5/);
      expect(block).toMatch(/not\s+found/i);
    });
  });

  describe('MockVideoProvider implementation', () => {
    const src = readServer('services/video/mock.provider.ts');

    it('implements setParticipantCanPublishAudio (no-op, logs only)', () => {
      expect(src).toMatch(/async setParticipantCanPublishAudio\(/);
      expect(src).toMatch(/MockVideo:\s*setParticipantCanPublishAudio/);
    });
  });

  describe('video.service.ts facade', () => {
    const src = readServer('services/video/video.service.ts');

    it('exposes setParticipantCanPublishAudio that delegates to provider', () => {
      expect(src).toMatch(/export async function setParticipantCanPublishAudio/);
      expect(src).toMatch(/return p\.setParticipantCanPublishAudio\(roomId, userId, canPublishAudio\)/);
    });
  });

  describe('host-actions.ts enforces via enforceLiveKitMute', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');

    it('handleHostMuteParticipant calls enforceLiveKitMute AFTER persisting host_muted', () => {
      const fnStart = src.indexOf('export async function handleHostMuteParticipant');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

      const persistIdx = fn.search(/UPDATE\s+session_participants[\s\S]{0,200}host_muted/i);
      const enforceIdx = fn.indexOf('enforceLiveKitMute');
      expect(persistIdx).toBeGreaterThan(-1);
      expect(enforceIdx).toBeGreaterThan(-1);
      expect(enforceIdx).toBeGreaterThan(persistIdx);
    });

    it('handleHostMuteAll bulk-fires enforceLiveKitMute per non-host participant', () => {
      const fnStart = src.indexOf('export async function handleHostMuteAll');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd > -1 ? fnEnd : src.length);

      expect(fn).toMatch(/enforceLiveKitMute\(\s*data\.sessionId,\s*participantId,\s*!data\.muted\s*\)/);
      // Bulk path skips the host roster (same allHostIds set used for
      // the DB UPDATE WHERE clause).
      expect(fn).toMatch(/allHostIds\.includes\(participantId\)/);
    });

    it('enforceLiveKitMute is private (not exported)', () => {
      // Helper is internal to host-actions — it should be `async function`,
      // not `export async function`. This pins the encapsulation.
      const fnIdx = src.indexOf('async function enforceLiveKitMute');
      expect(fnIdx).toBeGreaterThan(-1);
      // Make sure there's no `export` keyword immediately before.
      const preceding = src.slice(Math.max(0, fnIdx - 20), fnIdx);
      expect(preceding).not.toMatch(/export\s+$/);
    });

    it('enforceLiveKitMute applies permission to BOTH lobby room AND any active match room', () => {
      const fnIdx = src.indexOf('async function enforceLiveKitMute');
      const block = src.slice(fnIdx, fnIdx + 2500);
      // Reads sessions.lobby_room_id and applies if non-null.
      expect(block).toMatch(/SELECT\s+lobby_room_id\s+FROM\s+sessions/i);
      // Reads matches.room_id for any active match with this user.
      expect(block).toMatch(/SELECT\s+room_id\s+FROM\s+matches[\s\S]{0,300}status\s*=\s*['"]active['"]/i);
      // Calls videoService.setParticipantCanPublishAudio for each.
      const calls = block.match(/videoService\.setParticipantCanPublishAudio\(/g) || [];
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('LiveKit enforcement failure is non-fatal (logged, never thrown to caller)', () => {
      const fnIdx = src.indexOf('async function enforceLiveKitMute');
      const block = src.slice(fnIdx, fnIdx + 2500);
      // try / catch wraps the lookup + applies. Errors logged at warn
      // level — never re-thrown.
      expect(block).toMatch(/try\s*\{[\s\S]{0,1500}\}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]{0,500}logger\.warn/);
      expect(block).not.toMatch(/catch\s*\([\s\S]{0,200}throw\s+err/);
    });
  });
});
