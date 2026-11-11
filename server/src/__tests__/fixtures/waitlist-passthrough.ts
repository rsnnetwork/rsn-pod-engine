// ─── The waiting list, for a test whose registerParticipant is a mock (Part 3 Task 3) ─────────────────────
//
// Part 3 Task 3 routed the paths that may queue someone (the RSN Call link's entry, an approval, an invite accept)
// through event-waitlist.service's registerOrWaitlist, which composes the real registerParticipantTx under the event's
// capacity lock. A test that replaces session.service with a mock of registerParticipant hands that mock to this
// stand-in: every call is a place, as the mock gives it (the mock's own refusals come through unchanged), and nobody is
// ever queued. The waiting list itself is tested on its own (event-waitlist.test.ts, capacity-rules.test.ts, PGlite).

type Register = (...args: unknown[]) => unknown;

export function passThroughWaitlist(register: Register) {
  return {
    __esModule: true,
    registerOrWaitlist: async (sessionId: string, userId: string, role: unknown, options: { joinedVia?: string } & Record<string, unknown>) => {
      const { joinedVia: _joinedVia, ...registerOptions } = options;
      const participant = (await register(sessionId, userId, role, registerOptions)) as { isNewRegistration?: boolean } | undefined;
      return { kind: 'registered' as const, participant, isNewRegistration: !!participant?.isNewRegistration };
    },
    leaveWaitlist: async () => ({ left: false }),
    afterPlaceFreed: async () => undefined,
  };
}
