// ─── Socket Event Type Tests ────────────────────────────────────────────────
// Validates that the shared event type definitions include all expected events.

import type { ClientToServerEvents, ServerToClientEvents } from '@rsn/shared';

describe('Socket Event Types', () => {
  describe('ClientToServerEvents', () => {
    it('should include all host control events', () => {
      // Type-level validation: if any event is missing from the interface,
      // TypeScript will fail to compile this test file.
      const events: (keyof ClientToServerEvents)[] = [
        'session:join',
        'session:leave',
        'presence:heartbeat',
        'presence:ready',
        'rating:submit',
        'host:start_session',
        'host:start_round',
        'host:pause_session',
        'host:resume_session',
        'host:end_session',
        'host:broadcast_message',
        'host:remove_participant',
        'host:reassign',
        'host:generate_matches',
        'host:confirm_round',
        'host:swap_match',
        'host:exclude_participant',
        'host:regenerate_matches',
        'host:mute_participant',
        'host:mute_all',
      ];
      expect(events).toHaveLength(20);
    });

    it('should have host:mute_all event with correct signature', () => {
      // Compile-time check: the event accepts { sessionId, muted }
      type MuteAllData = Parameters<ClientToServerEvents['host:mute_all']>[0];
      const testData: MuteAllData = { sessionId: 'test-session', muted: true };
      expect(testData.sessionId).toBe('test-session');
      expect(testData.muted).toBe(true);
    });
  });

  describe('ServerToClientEvents', () => {
    it('should include all server events', () => {
      const events: (keyof ServerToClientEvents)[] = [
        'session:status_changed',
        'session:round_started',
        'session:round_ending',
        'session:round_ended',
        'session:completed',
        'match:assigned',
        'match:bye_round',
        'match:reassigned',
        'match:partner_disconnected',
        'match:partner_reconnected',
        'participant:joined',
        'participant:left',
        'participant:count',
        'session:state',
        'rating:window_open',
        'rating:window_closed',
        'host:broadcast',
        'host:participant_removed',
        'host:match_preview',
        'lobby:token',
        'lobby:mute_command',
        'timer:sync',
        'error',
      ];
      expect(events).toHaveLength(23);
    });

    it('should have lobby:mute_command with byHost field', () => {
      type MuteCommandData = Parameters<ServerToClientEvents['lobby:mute_command']>[0];
      const testData: MuteCommandData = { muted: true, byHost: true };
      expect(testData.muted).toBe(true);
      expect(testData.byHost).toBe(true);
    });
  });
});
