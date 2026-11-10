// ─── What a drop on the matching board means (10 Nov 2026 spec, Part 2 Task 13; spec 06 core interactions) ───
//
// Drag and drop is the desktop way to edit the board; the phone and the keyboard use MoveSheet, which sends the same
// ops. Native HTML5 drag and drop only (no library). A drop is turned into one board op here, and the server stays
// the judge of whether it may stand:
//   - onto an occupied seat: swap the two people (neither is dropped);
//   - onto an empty seat or a room's free place: move the person there (their old seat empties);
//   - into the basket: unassign them for that round (they stay known, waiting);
//   - anywhere in another round: nothing ("Drop it in the same round.").
// Pure on purpose: server/src/__tests__/client/p2-matching-board.test.ts runs it.

import type { BoardOp } from '@rsn/shared';

/** The person being dragged: their round, and the room they sit in (null in the basket, unknown when left out). */
export interface DragSource {
  round: number;
  userId: string;
  fromRoom?: number | null;
}

export type DropTarget =
  | { kind: 'seat'; round: number; room: number; occupantId: string | null }
  | { kind: 'basket'; round: number };

/** Said when someone is dropped into another round. */
export const DROP_SAME_ROUND = 'Drop it in the same round.';

/** The board op a drop asks for, or null when it asks for nothing (another round, or where they already are). */
export function dropIntent(source: DragSource, target: DropTarget): BoardOp | null {
  if (source.round !== target.round) return null;
  const round = source.round;
  if (target.kind === 'basket') {
    return source.fromRoom === null ? null : { kind: 'unassign', round, userId: source.userId };
  }
  if (target.occupantId === source.userId) return null;
  if (target.occupantId) {
    if (source.fromRoom != null && source.fromRoom === target.room) return null;
    return { kind: 'swap', round, userId: source.userId, withUserId: target.occupantId };
  }
  if (source.fromRoom === target.room) return null;
  return { kind: 'move', round, userId: source.userId, toRoom: target.room };
}

/** Why a drop does nothing, when the organiser should be told (a drop into another round). */
export function dropRefusal(source: DragSource, target: DropTarget): string | null {
  return source.round !== target.round ? DROP_SAME_ROUND : null;
}

/** The drag's own data type, so a file or a link dragged over the board is never read as a person. */
export const BOARD_DRAG_TYPE = 'application/x-reason-board-seat';

export function encodeDrag(source: DragSource): string {
  return JSON.stringify({ round: source.round, userId: source.userId, fromRoom: source.fromRoom ?? null });
}

export function decodeDrag(text: string): DragSource | null {
  try {
    const value = JSON.parse(text) as Partial<DragSource>;
    if (typeof value.round !== 'number' || typeof value.userId !== 'string') return null;
    const fromRoom = typeof value.fromRoom === 'number' ? value.fromRoom : null;
    return { round: value.round, userId: value.userId, fromRoom };
  } catch {
    return null;
  }
}
