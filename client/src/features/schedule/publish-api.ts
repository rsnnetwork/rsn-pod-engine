// ─── Publishing the board as a version (10 Nov 2026 spec, Part 2 Tasks 9 and 13; spec 06 "Preview and publish") ─
//
// The one place the board's screen talks to the publish routes, so the Publish control, the conflicts preview and
// the versions list follow the server's shapes from a single file:
//   GET  /sessions/:id/schedule/publish-preview   PublishPreview: blocking first, then warnings, who is affected
//   POST /sessions/:id/schedule/publish           { expectedRevision, note? } → { version, impactedUserIds }
//   GET  /sessions/:id/schedule/versions          the published versions, newest first
// The preview reads the draft, so it is kept live by the board's own tags; the versions list by the published
// schedule's tag as well (Task 9 sends it on every publish, automatic ones included).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorCodes, type ScheduleBoard } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { boardErrorOf } from './board-errors';
import { boardQueryKey, boardWriteScope } from './useBoard';

export interface PublishItem { round: number; room: number | null; message: string }

/** Task 9's PublishPreview (shared/src/types/schedule.ts on its branch), field for field. */
export interface PublishPreview {
  blocking: PublishItem[];
  warnings: PublishItem[];
  impactedUserIds: string[];
  nextVersion: number;
}

export interface PublishResult { version: number; impactedUserIds: string[] }

/** One published version as the versions list reads it; fields the server leaves out read as unknown. */
export interface ScheduleVersionSummary {
  version: number;
  publishedAt: string | null;
  publishedByName: string | null;
  automatic: boolean;
  reason: string | null;
  impactedCount: number | null;
}

/** The published schedule's tag (Task 9 adds `E.sessionPublishedSchedule`; the same text until then). */
export const publishedScheduleTag = (sessionId: string) => `session:${sessionId}:published-schedule`;

export const publishCopy = {
  title: 'Publish the board',
  publishVersion: (n: number) => `Publish version ${n}`,
  published: (n: number) => `Version ${n} published`,
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

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Why an automatic version was made, in words (Task 9's reasons); an unknown code is never shown as it is. */
const REASON_WORDS: Record<string, string> = {
  late_joiner: 'Someone arrived late',
  left: 'Someone left',
  host_request: 'Repaired on request',
  live_edit: 'Changed during the event',
};
const reasonWords = (v: unknown) => {
  const text = str(v);
  if (!text) return null;
  return REASON_WORDS[text] ?? (/^[a-z_]+$/.test(text) ? null : text);
};

/** A versions row, read defensively: a field the server names differently or leaves out is shown as unknown. */
export function readVersion(raw: Record<string, unknown>): ScheduleVersionSummary | null {
  const version = num(raw.version);
  if (version === null) return null;
  const by = raw.publishedBy as Record<string, unknown> | string | null | undefined;
  return {
    version,
    publishedAt: str(raw.publishedAt) ?? str(raw.createdAt),
    publishedByName: str(raw.publishedByName) ?? (typeof by === 'object' && by ? str(by.displayName) : str(by)),
    automatic: raw.automatic === true,
    reason: reasonWords(raw.reason) ?? str(raw.note),
    impactedCount: num(raw.impactedCount) ?? (Array.isArray(raw.impactedUserIds) ? raw.impactedUserIds.length : null),
  };
}

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
    queryFn: () => api.get(`/sessions/${sessionId}/schedule/versions`).then((r) => {
      const rows = Array.isArray(r.data.data) ? (r.data.data as Array<Record<string, unknown>>) : [];
      return rows.map(readVersion).filter((v): v is ScheduleVersionSummary => v !== null).sort((a, b) => b.version - a.version);
    }),
    enabled: open && !!sessionId,
    retry: false,
    meta: { entities: [E.sessionSchedule(sessionId), publishedScheduleTag(sessionId)] },
  });
}

/**
 * Publish the board on screen. A board that changed meanwhile comes back with the error and is shown through
 * `applyReturnedBoard` (useBoard's, the one cache write); conflicts found at publish time read the preview again.
 */
export function usePublish(sessionId: string, applyReturnedBoard: (board: ScheduleBoard) => void) {
  const qc = useQueryClient();
  return useMutation({
    // Behind any board edit still on its way, so it publishes the revision that edit returned.
    scope: { id: boardWriteScope(sessionId) },
    mutationFn: async (note?: string) => {
      const board = qc.getQueryData<ScheduleBoard>(boardQueryKey(sessionId));
      const res = await api.post(`/sessions/${sessionId}/schedule/publish`, { expectedRevision: board?.revision ?? 0, ...(note ? { note } : {}) });
      return res.data.data as PublishResult;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: boardQueryKey(sessionId) });
      void qc.invalidateQueries({ queryKey: versionsKey(sessionId) });
      void qc.invalidateQueries({ queryKey: previewKey(sessionId) });
    },
    onError: (err) => {
      const error = boardErrorOf(err);
      if (error.code === ErrorCodes.SCHEDULE_CHANGED && error.board) applyReturnedBoard(error.board);
      // Any other refusal (conflicts found at publish time, a 409 without a board) reads the board again.
      else if (error.status === 409) void qc.invalidateQueries({ queryKey: boardQueryKey(sessionId) });
      void qc.invalidateQueries({ queryKey: previewKey(sessionId) });
    },
  });
}
