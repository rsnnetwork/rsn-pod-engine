// ─── Where focus goes, and what is said, after a board change (fix round 1, Task 13 review Important 1) ───
//
// Select and move is the keyboard's and the screen reader's way to edit the board (spec 06), so neither may lose
// their place or the result. After a change:
//   - the person it moved gets focus in their new seat (their chip is a new element there, so focus is placed once
//     the board the server answered with is on screen: `revision` says which board that is);
//   - a refused change gives focus back to the chip the action started from, or, when a choice of alternatives opened
//     (RefusalSheet), once that sheet closes (the sheet would otherwise take it back to where it was opened from);
//   - the board's own polite live region says what happened ("Ann is in Room 03 now."). The reason for a refusal is
//     already read out by the error toast's assertive region or the refusal sheet, so the region only says nothing moved.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardOp, ScheduleBoard } from '@rsn/shared';
import { outcomeSentence, personOfOp, stayedSentence } from './board-model';
import type { RunOutcome } from './useBoard';

/** The chip of a person on the board. */
export const seatSelector = (userId: string) => `[data-testid="board-person-${userId}"]`;

export interface PendingFocus { userId: string; revision: number }

export interface Feedback {
  /** What the live region says. */
  say: string;
  /** Whose chip gets focus, once the board at that revision is on screen. */
  focus: PendingFocus | null;
  /** A choice of alternatives opened: focus goes back to this person when it closes. */
  holdForSheet: string | null;
}

/**
 * The feedback for one change: on success the moved person (else the person the action started from) gets focus in
 * the board the server answered with, and the sentence says where they are; on a refusal nobody moved, focus goes
 * back to where the action started (after the refusal sheet when one opened).
 */
export function feedbackFor(
  outcome: RunOutcome, op: BoardOp, origin: string | null, boardBefore: ScheduleBoard, success: string | null = null,
): Feedback {
  if (outcome.ok) {
    const board = outcome.result.board;
    const moved = personOfOp(op) ?? origin;
    return {
      say: outcomeSentence(board, op) ?? success ?? 'Saved.',
      focus: moved ? { userId: moved, revision: board.revision } : null,
      holdForSheet: null,
    };
  }
  const now = outcome.error.board ?? boardBefore;
  return {
    say: stayedSentence(now, op),
    focus: !outcome.offered && origin ? { userId: origin, revision: now.revision } : null,
    holdForSheet: outcome.offered ? origin : null,
  };
}

export function useMoveFeedback(board: ScheduleBoard | undefined) {
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 });
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const refusalOrigin = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingFocus || !board || board.revision < pendingFocus.revision) return;
    document.querySelector<HTMLElement>(seatSelector(pendingFocus.userId))?.focus();
    setPendingFocus(null);
  }, [pendingFocus, board]);

  /** Say this in the board's live region (a new element each time, so the same words are read again). */
  const announce = useCallback((text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 })), []);

  /** Act on a change's feedback: say it, and place focus (now, or when the refusal sheet closes). */
  const apply = useCallback((feedback: Feedback) => {
    announce(feedback.say);
    if (feedback.focus) setPendingFocus(feedback.focus);
    if (feedback.holdForSheet) refusalOrigin.current = feedback.holdForSheet;
  }, [announce]);

  /** The refusal sheet closed: focus the chip the action started from (a choice made in it moves focus again later). */
  const releaseFocusAfterSheet = useCallback((revision: number) => {
    const origin = refusalOrigin.current;
    refusalOrigin.current = null;
    if (origin) setPendingFocus({ userId: origin, revision });
  }, []);

  return { announcement, apply, releaseFocusAfterSheet };
}
