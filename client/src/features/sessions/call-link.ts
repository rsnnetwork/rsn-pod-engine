// ─── The event's links, for its organisers: the one module that talks to their routes (Part 2 Task 11) ─────────────
// Task 6's organiser routes (server/src/routes/call-links.ts, sessionCallLinkRoutes):
//   GET  /api/sessions/:id/call-link         → { code, path, url, eventLink } (the code is made on first read; eventLink
//                                              is the event link, /events/<name>-<n>[-<tail>], Stefan 11 Nov 2026)
//   POST /api/sessions/:id/call-link/rotate  → the same shape with a new code; the old link stops working at once
// Rotating tells the organisers' screens session:<id>:call-link and session:<id> (call-link.service.ts fanoutCallLink),
// so every organiser's card follows. The link shown and copied is this site's origin and the shared callLinkPath(code)
// (CALL_LINK_BASE_PATH, the one place the path is named); the server's `url` is not shown (see callLinkAddress).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callLinkPath, type EventLinkInfo } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

/** What both routes answer. `eventLink` is absent from an older server. */
export interface CallLink {
  code: string;
  path: string;
  url: string;
  eventLink?: EventLinkInfo;
}

export const callLinkKey = (sessionId: string) => ['session-call-link', sessionId] as const;

/**
 * The address to show and copy: always this site's origin and callLinkPath(code). The server's `url` is built from its
 * CLIENT_URL (production's app), which has no call-link page until this client ships there; from this site the link
 * opens the site it was copied on, and once shipped the origin is production's anyway (controller ruling, 11 Nov 2026).
 */
export function callLinkAddress(link: Pick<CallLink, 'code'>, origin: string): string {
  return `${origin}${callLinkPath(link.code)}`;
}

/**
 * The address the card shows and copies: the event link as the server writes it (on EVENT_LINK_BASE_URL when that is
 * set, else on the site the organiser asked from), else, from an older server, the call link on this site.
 */
export function eventLinkAddress(link: CallLink, origin: string): string {
  return link.eventLink?.url ?? callLinkAddress(link, origin);
}

export function useCallLink(sessionId: string, enabled: boolean) {
  return useQuery<CallLink>({
    queryKey: callLinkKey(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/call-link`).then((r) => r.data.data as CallLink),
    enabled,
    // A 403/404 is an answer (not an organiser, or no such event): asked once, not three times.
    retry: (count, err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      // Review I2: never a 429, whose re-read waits for the limit's window (realtime/rate-limited-reads.ts).
      return status !== 403 && status !== 404 && status !== 429 && count < 2;
    },
    // Review I3 (11 Nov 2026): only its own tag. The read is the code and the address, which change only when the code
    // is first given or rotated, and both tell session:<id>:call-link (call-link.service fanoutCallLink). Under
    // session:<id> it was read again for every registration, join and leave, which spent the organiser's request limit.
    meta: { entities: [E.sessionCallLink(sessionId)] },
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
