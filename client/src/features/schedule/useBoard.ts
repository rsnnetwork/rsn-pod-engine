// ─── The matching board's data (10 Nov 2026 spec, Part 2 Task 13) ────────────────────────────────────────
//
// One read (GET /sessions/:id/schedule), kept live by the board's three tags: the draft itself (any organiser's
// edit), the event's groups (a regroup changes a room's verdict) and its people (someone registers or leaves: the
// basket). Every write names the revision of the board on screen; the server answers with the whole board, which IS
// the server's state, so it is put in the cache as it came (the one setQueryData here, applyReturnedBoard). A write
// made against an older board is refused with the board as it is now: that board is shown, with the server's
// sentence. A move the room checker refuses comes back with alternatives, for the screen to offer.
//
// A read that was already on its way when a write answered must not put the older board back: the cache keeps the
// higher revision (keepNewestBoard).

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorCodes, type BoardOp, type BoardOpResult, type BoardRefusal, type ScheduleBoard } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useToastStore } from '@/stores/toastStore';
import { boardErrorOf, type BoardError } from './board-errors';

export const boardQueryKey = (sessionId: string) => ['schedule-board', sessionId] as const;

/** Of two boards, the newer: a read that left before a write answered never puts the older one back. */
export function keepNewestBoard(old: unknown, next: unknown): unknown {
  const a = old as ScheduleBoard | undefined;
  const b = next as ScheduleBoard | undefined;
  return a && b && typeof a.revision === 'number' && typeof b.revision === 'number' && a.revision > b.revision ? a : next;
}

export type BoardWrite =
  | { kind: 'op'; op: BoardOp }
  | { kind: 'generate'; rounds: number[] | 'all' };

/** A move or swap the room checker refused, with where the person could go instead. */
export interface PendingRefusal {
  op: BoardOp;
  code: string;
  message: string;
  alternatives: BoardRefusal['alternatives'];
  /** The rule refused it, and this organiser may seat them anyway (recorded). */
  overridable: boolean;
}

const REFUSED_WITH_CHOICES: ReadonlySet<string> = new Set([ErrorCodes.SCHEDULE_GROUP_RULE, ErrorCodes.SCHEDULE_RULE]);

async function sendWrite(sessionId: string, expectedRevision: number, write: BoardWrite): Promise<BoardOpResult> {
  const res = write.kind === 'generate'
    ? await api.post(`/sessions/${sessionId}/schedule/generate`, { expectedRevision, rounds: write.rounds })
    : await api.post(`/sessions/${sessionId}/schedule/ops`, { expectedRevision, op: write.op });
  return res.data.data as BoardOpResult;
}

export function useBoard(sessionId: string) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [refusal, setRefusal] = useState<PendingRefusal | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);

  const query = useQuery({
    queryKey: boardQueryKey(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/schedule`).then((r) => r.data.data as ScheduleBoard),
    enabled: !!sessionId,
    structuralSharing: keepNewestBoard,
    retry: (failures, err) => {
      const status = boardErrorOf(err).status;
      return status !== 403 && status !== 404 && status !== 409 && failures < 2;
    },
    meta: { entities: [E.sessionSchedule(sessionId), E.sessionGroups(sessionId), E.sessionParticipants(sessionId)] },
  });

  /** The server's board, as it answered: the only way the cache is written by hand. */
  const applyReturnedBoard = useCallback((board: ScheduleBoard) => {
    void qc.cancelQueries({ queryKey: boardQueryKey(sessionId) });
    qc.setQueryData(boardQueryKey(sessionId), board);
  }, [qc, sessionId]);

  const mutation = useMutation({
    mutationFn: (write: BoardWrite) => {
      const current = qc.getQueryData<ScheduleBoard>(boardQueryKey(sessionId));
      return sendWrite(sessionId, current?.revision ?? 0, write);
    },
    onSuccess: (result) => applyReturnedBoard(result.board),
  });

  /** What the screen does with a refused write: the board now, the alternatives, or the sentence. */
  const handleRefusal = useCallback((write: BoardWrite, error: BoardError) => {
    if (error.code === ErrorCodes.SCHEDULE_CHANGED && error.board) {
      applyReturnedBoard(error.board);
      addToast(error.message, 'error');
      return;
    }
    if (write.kind === 'op' && REFUSED_WITH_CHOICES.has(error.code) && error.alternatives) {
      const canOverride = qc.getQueryData<ScheduleBoard>(boardQueryKey(sessionId))?.canOverride ?? false;
      setRefusal({
        op: write.op, code: error.code, message: error.message, alternatives: error.alternatives,
        overridable: error.code === ErrorCodes.SCHEDULE_GROUP_RULE && canOverride && write.op.override !== true,
      });
      return;
    }
    addToast(error.message, 'error');
  }, [addToast, applyReturnedBoard, qc, sessionId]);

  /** One write. Resolves with the server's answer, or null when it was refused (the screen has been told why). */
  const run = useCallback(async (write: BoardWrite, success?: (result: BoardOpResult) => string | null): Promise<BoardOpResult | null> => {
    try {
      const result = await mutation.mutateAsync(write);
      const said = success?.(result);
      if (said) addToast(said, 'success');
      return result;
    } catch (err) {
      handleRefusal(write, boardErrorOf(err));
      return null;
    }
  }, [addToast, handleRefusal, mutation]);

  /** Several ops one after another, each against the board the one before returned; stops at the first refusal. */
  const runAll = useCallback(async (ops: BoardOp[], success?: string): Promise<boolean> => {
    setQueueBusy(true);
    try {
      for (const op of ops) if (!(await run({ kind: 'op', op }))) return false;
      if (success) addToast(success, 'success');
      return true;
    } finally {
      setQueueBusy(false);
    }
  }, [addToast, run]);

  return {
    board: query.data,
    isLoading: query.isLoading,
    error: query.error ? boardErrorOf(query.error) : null,
    refetch: query.refetch,
    busy: mutation.isPending || queueBusy,
    run,
    runAll,
    applyReturnedBoard,
    refusal,
    clearRefusal: () => setRefusal(null),
  };
}

export type BoardApi = ReturnType<typeof useBoard>;
