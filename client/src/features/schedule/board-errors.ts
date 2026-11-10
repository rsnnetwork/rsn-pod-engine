// ─── What a refused board write says (10 Nov 2026 spec, Part 2 Task 13) ──────────────────────────────────
//
// The board's server answers a refused write with a code, a sentence written for the organiser, and sometimes more:
// the board as it is now (SCHEDULE_CHANGED: someone else edited first) or the rooms the person could go to instead
// (a move the room checker refuses). Pure, so the test runs it.

import type { BoardRefusal, ScheduleBoard } from '@rsn/shared';
import { CONNECTION_LOST, gotNoAnswer, memberSentence } from '@/features/reason/errors';

export interface BoardError {
  status: number | null;
  code: string;
  message: string;
  /** The board now, sent with SCHEDULE_CHANGED. */
  board: ScheduleBoard | null;
  /** Where the person could go instead, sent with a refused move or swap. */
  alternatives: BoardRefusal['alternatives'] | null;
}

const FALLBACK = "That didn't work. Try again.";
const SLOW_DOWN = 'Slow down a moment, then try again.';
const GONE = "We couldn't find that event.";

function isBoard(value: unknown): value is ScheduleBoard {
  const b = value as Partial<ScheduleBoard> | null;
  return !!b && typeof b === 'object' && typeof b.revision === 'number' && Array.isArray(b.rounds) && Array.isArray(b.people);
}

function isAlternatives(value: unknown): value is BoardRefusal['alternatives'] {
  return Array.isArray(value) && value.every((a) => a && typeof a.room === 'number' && typeof a.note === 'string');
}

interface Failed {
  response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown; details?: { board?: unknown; alternatives?: unknown } } } };
}

/** The parts of a failed board request the screen uses, in words fit to show. */
export function boardErrorOf(err: unknown): BoardError {
  const response = (typeof err === 'object' && err !== null ? (err as Failed).response : undefined);
  if (!response) {
    return { status: null, code: '', message: gotNoAnswer(err) ? CONNECTION_LOST : FALLBACK, board: null, alternatives: null };
  }
  const error = response.data?.error;
  const status = response.status ?? null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = status === 429 ? SLOW_DOWN
    : status === 404 ? GONE
    : (status === 400 || status === 403 || status === 409) ? memberSentence(error?.message) ?? FALLBACK
    : FALLBACK;
  return {
    status,
    code,
    message,
    board: isBoard(error?.details?.board) ? error.details.board : null,
    alternatives: isAlternatives(error?.details?.alternatives) ? error.details.alternatives : null,
  };
}
