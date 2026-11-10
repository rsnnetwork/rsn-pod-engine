// ─── The event's RSN Call link, for its organisers: the one module that talks to its routes (Part 2 Task 11) ─────────
// Task 6's organiser routes: GET /api/sessions/:id/call-link → { code, path, url } (the code made on first read),
// POST /api/sessions/:id/call-link/rotate → the same shape with a new code (the old link stops working at once). Every
// screen reads the link from here, so the card works the day those routes are on the server, and draws nothing before
// (their 404 reads as "not for this viewer"). The link shown is the server's `url` (built from CALL_LINK_BASE_PATH,
// the one place the path is named); without one, this site's origin and the server's `path`.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

export interface CallLink {
  code: string;
  path: string;
  url?: string | null;
}

export const callLinkKey = (sessionId: string) => ['session-call-link', sessionId] as const;

/** The address to share: the server's own, else this site's origin and the path. */
export function callLinkAddress(link: CallLink, origin: string): string {
  if (link.url) return link.url;
  return `${origin}${link.path.startsWith('/') ? '' : '/'}${link.path}`;
}

export function useCallLink(sessionId: string, enabled: boolean) {
  return useQuery<CallLink>({
    queryKey: callLinkKey(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/call-link`).then((r) => r.data.data as CallLink),
    enabled,
    // A 403/404 is an answer (not an organiser, or no call link on this server yet): asked once, not three times.
    retry: (count, err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      return status !== 403 && status !== 404 && count < 2;
    },
    meta: { entities: [E.session(sessionId)] },
  });
}

export function useRotateCallLink(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: () => api.post(`/sessions/${sessionId}/call-link/rotate`).then((r) => r.data.data as CallLink),
    onSuccess: () => { qc.invalidateQueries({ queryKey: callLinkKey(sessionId) }); },
  });
}
