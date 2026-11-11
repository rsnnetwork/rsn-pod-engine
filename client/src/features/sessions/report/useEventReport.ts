// ─── The organisers' event report, read and downloaded (Part 3 Task 9, over Task 4's GET /sessions/:id/report) ─────
// The report follows the event (session:<id>: it ended, its details changed), its places (session:<id>:participants:
// someone registered, came, left or was removed), its ratings (session:<id>:ratings: once per round after the ratings
// close, and for a late rating once it has ended) and its groups (session:<id>:groups: the group names on each
// person). Anyone but the people running the event is refused (403), and an unknown event is 404: neither is retried,
// and the card draws nothing for them.

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EventReport, EventReportSection } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useToastStore } from '@/stores/toastStore';
import { notForThisViewer } from '../organiser-errors';
import { downloadReportSection } from './download-report';
import { downloadFailedSentence } from './report-text';

export function useEventReport(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: ['event-report', sessionId],
    queryFn: ({ signal }) => api.get(`/sessions/${sessionId}/report`, { signal }).then((r) => r.data.data as EventReport),
    enabled: enabled && !!sessionId,
    retry: (count, err: unknown) => !notForThisViewer(err) && count < 2,
    meta: { entities: [E.session(sessionId), E.sessionParticipants(sessionId), E.sessionRatings(sessionId), E.sessionGroups(sessionId)] },
  });
}

/**
 * The three download buttons' state: which one is fetching, and a toast when one fails. A second press while one runs
 * does nothing: the guard is a ref, set before anything awaits, so two taps in one frame (before React has drawn the
 * disabled buttons) still start one download.
 */
export function useReportDownloads(sessionId: string, report: EventReport | undefined) {
  const addToast = useToastStore((s) => s.addToast);
  const [busy, setBusy] = useState<EventReportSection | null>(null);
  const running = useRef(false);
  const download = async (section: EventReportSection) => {
    if (running.current) return;
    running.current = true;
    setBusy(section);
    try {
      await downloadReportSection(sessionId, section, report);
    } catch (err) {
      addToast(downloadFailedSentence(err), 'error');
    } finally {
      running.current = false;
      setBusy(null);
    }
  };
  return { download, busy };
}
