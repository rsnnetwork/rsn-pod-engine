// A meeting locked on the matching board, as the live host's screens show it (10 Nov 2026 spec, Part 2 Tasks 9 and 13).
// The live event keeps a locked meeting through every regenerate and repair; the host's swap and exclude are refused
// for it with this sentence (the server's own, word for word), and its room carries this label once the live payloads
// say which meetings are locked (`locked` on host:match_preview matches and host:round_dashboard rooms; not sent yet).

export const LOCKED_MEETING = 'This meeting is locked on the matching board.';
export const LOCKED_LABEL = 'Locked';
/**
 * The socket error codes that mean the meeting is locked: the live swap and exclude send SCHEDULE_LOCKED with the
 * sentence above (server matching-flow.ts, LOCKED_MATCH_MESSAGE in schedule-live.service.ts).
 */
export const LOCKED_CODES: readonly string[] = ['SCHEDULE_LOCKED'];
