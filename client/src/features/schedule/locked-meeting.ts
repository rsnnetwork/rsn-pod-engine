// A meeting locked on the matching board, as the live host's screens show it (10 Nov 2026 spec, Part 2 Tasks 9 and 13).
// The live event keeps a locked meeting through every regenerate and repair; the host's swap and exclude are refused
// for it with this sentence, and its room carries this label.

export const LOCKED_MEETING = 'This meeting is locked on the matching board.';
export const LOCKED_LABEL = 'Locked';
/** The socket error codes that mean the meeting is locked (the board's code, and the live match's). */
export const LOCKED_CODES: readonly string[] = ['SCHEDULE_LOCKED', 'MATCH_LOCKED'];
