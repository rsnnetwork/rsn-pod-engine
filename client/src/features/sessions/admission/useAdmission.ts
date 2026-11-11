// ─── Admission's reads and writes for the event page (Part 2 Task 11 over Task 4's routes) ──────────────────────────
// Every read follows session:<id>:admission (each admission write sends it) and session:<id>:participants (a person
// taking a place turns an address into "Has a place" and moves the counts). Writes refresh their own reads as well, so
// the organiser's screen turns at once; the tags bring every other organiser's screen along.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddAdmissionEmailsResult, AdmissionCodeRow, AdmissionEntryRow, AdmissionMode, EventAdmissionOverview, GeneratedAdmissionCode,
} from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

const PAGE = 50;

export const admissionKeys = {
  overview: (sessionId: string) => ['session-admission', sessionId] as const,
  emails: (sessionId: string, q: string) => ['session-admission-emails', sessionId, q] as const,
  codes: (sessionId: string) => ['session-admission-codes', sessionId] as const,
};

const admissionEntities = (sessionId: string) => [E.sessionAdmission(sessionId), E.sessionParticipants(sessionId)];

/** A 403/404 is an answer (not an organiser; no such event): asked once. */
const retryUnlessRefused = (count: number, err: unknown) => {
  const status = (err as { response?: { status?: number } })?.response?.status;
  // Review I2: never a 429, whose re-read waits for the limit's window (realtime/rate-limited-reads.ts).
  return status !== 403 && status !== 404 && status !== 429 && count < 2;
};

export function useAdmissionOverview(sessionId: string) {
  return useQuery<EventAdmissionOverview>({
    queryKey: admissionKeys.overview(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/admission`).then((r) => r.data.data as EventAdmissionOverview),
    retry: retryUnlessRefused,
    meta: { entities: admissionEntities(sessionId) },
  });
}

export function useAdmissionEmails(sessionId: string, q: string) {
  return useInfiniteQuery({
    queryKey: admissionKeys.emails(sessionId, q),
    queryFn: ({ pageParam, signal }) => api.get(`/sessions/${sessionId}/admission/emails`, {
      params: { q: q || undefined, cursor: pageParam || undefined, limit: PAGE }, signal,
    }).then((r) => r.data.data as { entries: AdmissionEntryRow[]; nextCursor: string | null }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
    retry: retryUnlessRefused,
    meta: { entities: admissionEntities(sessionId) },
  });
}

export function useAdmissionCodes(sessionId: string) {
  return useQuery<AdmissionCodeRow[]>({
    queryKey: admissionKeys.codes(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/admission/codes`).then((r) => (r.data.data ?? []) as AdmissionCodeRow[]),
    retry: retryUnlessRefused,
    // Review I3 (11 Nov 2026): only session:<id>:admission. The list never reads the event's places (a code's state is its
    // own row: made, revoked, redeemed), and every one of those writes tells session:<id>:admission
    // (fanoutAdmissionChanged), so a registration need not read it again.
    meta: { entities: [E.sessionAdmission(sessionId)] },
  });
}

/** Refresh every admission read of this event (and the page's own event, whose access block a mode changes). */
function useRefreshAdmission(sessionId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['session-admission', sessionId] });
    qc.invalidateQueries({ queryKey: ['session-admission-emails', sessionId] });
    qc.invalidateQueries({ queryKey: ['session-admission-codes', sessionId] });
  };
}

export function useSetAdmissionMode(sessionId: string) {
  const refresh = useRefreshAdmission(sessionId);
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (mode: AdmissionMode | null) => api.put(`/sessions/${sessionId}/admission`, { mode }).then((r) => r.data.data as EventAdmissionOverview),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}

export function useAddAdmissionEmails(sessionId: string) {
  const refresh = useRefreshAdmission(sessionId);
  return useMutation({
    networkMode: 'always',
    mutationFn: (body: { emails: string[]; source: 'paste' } | { csv: string; source: 'csv' }) =>
      api.post(`/sessions/${sessionId}/admission/emails`, body).then((r) => r.data.data as AddAdmissionEmailsResult),
    onSuccess: refresh,
  });
}

export function useRevokeAdmissionEmail(sessionId: string) {
  const refresh = useRefreshAdmission(sessionId);
  return useMutation({
    networkMode: 'always',
    mutationFn: (entryId: string) => api.delete(`/sessions/${sessionId}/admission/emails/${entryId}`),
    onSuccess: refresh,
  });
}

export function useGenerateAdmissionCodes(sessionId: string) {
  const refresh = useRefreshAdmission(sessionId);
  return useMutation({
    networkMode: 'always',
    mutationFn: (body: { count: number; label?: string }) =>
      api.post(`/sessions/${sessionId}/admission/codes`, body).then((r) => (r.data.data?.codes ?? []) as GeneratedAdmissionCode[]),
    onSuccess: refresh,
  });
}

export function useRevokeAdmissionCode(sessionId: string) {
  const refresh = useRefreshAdmission(sessionId);
  return useMutation({
    networkMode: 'always',
    mutationFn: (codeId: string) => api.delete(`/sessions/${sessionId}/admission/codes/${codeId}`),
    onSuccess: refresh,
  });
}
