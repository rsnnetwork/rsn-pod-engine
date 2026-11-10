// ─── Publishing the board as a version (10 Nov 2026 spec, Part 2 Tasks 9 and 13; spec 06 "Preview and publish") ─
//
// The one place the board's screen talks to Task 9's publish routes (server/src/routes/schedule.ts):
//   GET  /sessions/:id/schedule/publish-preview   PublishPreview: blocking first, then warnings, who is affected
//   POST /sessions/:id/schedule/publish           { expectedRevision, note? } → PublishResult { version, impactedUserIds,
//        revision }. Refused 409 SCHEDULE_HAS_CONFLICTS (details.blocking) or SCHEDULE_CHANGED (details.board). A
//        draft equal to the latest version writes nothing and answers that version with the revision unchanged (and
//        settles the board's live conflicts, if it had any).
//   GET  /sessions/:id/schedule/versions          ScheduleVersionSummary[], latest first
// The preview reads the draft, so it is kept live by the board's own tags; the versions list by the published
// schedule's tag as well (sent on every publish, the product's automatic ones included).

import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationOptions } from '@tanstack/react-query';
import {
  ErrorCodes, type PublishPreview, type PublishResult, type ScheduleBoard, type ScheduleVersionSummary,
} from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { boardErrorOf } from './board-errors';
import { boardQueryKey, boardWriteScope } from './useBoard';

export const publishCopy = {
  title: 'Publish the board',
  publishVersion: (n: number) => `Publish version ${n}`,
  published: (n: number) => `Version ${n} published`,
  unchanged: (n: number) => `Nothing changed since version ${n}, so nothing new was published.`,
  matches: (n: number) => `The board matches version ${n}. Change something on it to publish again.`,
  impacted: (n: number) => (n === 0
    ? 'Nobody\'s meetings change, so nobody is told.'
    : `${n} ${n === 1 ? 'person is' : 'people are'} told their meetings changed.`),
  blockingTitle: 'Fix these before publishing',
  warningsTitle: 'Worth a look',
  clean: 'No conflicts. The board is ready to publish.',
  versionsTitle: 'Published versions',
  noVersions: 'Nothing published yet. People see their meetings once you publish.',
  automatic: 'Automatic',
  loadFailed: "We couldn't load the publish preview. Try again.",
} as const;

/** Why a version was made, in words: the reasons Task 9 records (schedule-live.service.ts); a code is never shown. */
const REASON_WORDS: Record<string, string> = {
  late_joiner: 'Someone arrived late',
  left: 'Someone left',
  host_request: 'Repaired on request',
  live_edit: 'Changed during the event',
};
export const reasonWords = (reason: string | null): string | null => (reason ? REASON_WORDS[reason] ?? null : null);

/** One line of the versions list: when, who ("Automatic" for the product's own), why, the note, how many were told. */
export function versionLine(v: ScheduleVersionSummary, when: string | null): string {
  return [
    when,
    v.automatic || !v.publishedBy ? publishCopy.automatic : `by ${v.publishedBy.displayName}`,
    reasonWords(v.reason),
    v.note,
    `${v.impactedCount} ${v.impactedCount === 1 ? 'person' : 'people'} told`,
  ].filter(Boolean).join(' · ');
}

/** Whether Publish has anything to do: a draft that differs from the latest version, or live conflicts to settle. */
export const hasSomethingToPublish = (board: ScheduleBoard) =>
  board.publishedVersion === null || board.draftDiffersFromPublished || board.liveConflicts.length > 0;

const previewKey = (sessionId: string) => ['schedule-publish-preview', sessionId] as const;
const versionsKey = (sessionId: string) => ['schedule-versions', sessionId] as const;

export function usePublishPreview(sessionId: string, open: boolean) {
  return useQuery({
    queryKey: previewKey(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/schedule/publish-preview`).then((r) => r.data.data as PublishPreview),
    enabled: open && !!sessionId,
    retry: false,
    meta: { entities: [E.sessionSchedule(sessionId), E.sessionGroups(sessionId), E.sessionParticipants(sessionId)] },
  });
}

export function useScheduleVersions(sessionId: string, open: boolean) {
  return useQuery({
    queryKey: versionsKey(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/schedule/versions`).then((r) => (r.data.data ?? []) as ScheduleVersionSummary[]),
    enabled: open && !!sessionId,
    retry: false,
    meta: { entities: [E.sessionSchedule(sessionId), E.sessionPublishedSchedule(sessionId)] },
  });
}

/** A publish that wrote nothing: the draft equalled the latest version, so the board's revision did not move. */
export const wasUnchanged = (result: PublishResult, sentRevision: number) => result.revision === sentRevision;

/** What a publish answers, with the revision it was sent against (to tell a publish that wrote nothing). */
export interface PublishOutcome { result: PublishResult; sentRevision: number }

/**
 * Publish the board on screen. It queues behind any board edit on its way (one scope), and a publish moves the
 * board's revision, so the board is read again before the next queued edit runs (onSuccess is awaited before the
 * scope's next write starts). A board that changed meanwhile comes back with the error and is shown through
 * `applyReturnedBoard` (useBoard's one cache write); any other refusal reads the board and the preview again.
 */
export function publishOptions(
  qc: QueryClient, sessionId: string, applyReturnedBoard: (board: ScheduleBoard) => void,
): UseMutationOptions<PublishOutcome, unknown, string | undefined> {
  return {
    scope: { id: boardWriteScope(sessionId) },
    mutationFn: async (note?: string) => {
      const sentRevision = qc.getQueryData<ScheduleBoard>(boardQueryKey(sessionId))?.revision ?? 0;
      const res = await api.post(`/sessions/${sessionId}/schedule/publish`, { expectedRevision: sentRevision, ...(note ? { note } : {}) });
      return { result: res.data.data as PublishResult, sentRevision };
    },
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: versionsKey(sessionId) });
      void qc.invalidateQueries({ queryKey: previewKey(sessionId) });
      await qc.invalidateQueries({ queryKey: boardQueryKey(sessionId) });
    },
    onError: async (err) => {
      const error = boardErrorOf(err);
      void qc.invalidateQueries({ queryKey: previewKey(sessionId) });
      if (error.code === ErrorCodes.SCHEDULE_CHANGED && error.board) applyReturnedBoard(error.board);
      // Any other refusal (conflicts found at publish time, a 409 without a board) reads the board again.
      else if (error.status === 409) await qc.invalidateQueries({ queryKey: boardQueryKey(sessionId) });
    },
  };
}

export function usePublish(sessionId: string, applyReturnedBoard: (board: ScheduleBoard) => void) {
  const qc = useQueryClient();
  return useMutation(publishOptions(qc, sessionId, applyReturnedBoard));
}
