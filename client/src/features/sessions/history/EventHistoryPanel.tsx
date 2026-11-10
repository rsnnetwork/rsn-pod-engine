// ─── The event's history, for the people running it (Part 2 Task 11 over Task 1's GET /sessions/:id/audit) ──────────
// Newest first, 20 at a time, with Show older. It follows session:<id>:audit, which every audited step sends, so a
// publish, an admission change or a cancel appears without a refresh. Anyone else's read is refused, and the panel
// draws nothing.
import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import api from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { E } from '@/realtime/entities';
import { notForThisViewer } from '../organiser-errors';
import { EmptyRow, ErrorRow, LoadingRows, OrganiserCard, QUIET_BUTTON } from '../organiser-ui';
import { HISTORY_COPY, historyDetail, historySentence, type HistoryEntry } from './history-text';

const PAGE = 20;

export default function EventHistoryPanel({ sessionId }: { sessionId: string }) {
  const history = useInfiniteQuery({
    queryKey: ['session-audit', sessionId],
    queryFn: ({ pageParam, signal }) => api.get(`/sessions/${sessionId}/audit`, {
      params: { limit: PAGE, cursor: pageParam || undefined }, signal,
    }).then((r) => r.data.data as { entries: HistoryEntry[]; nextCursor: string | null }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: (count, err: unknown) => !notForThisViewer(err) && count < 2,
    meta: { entities: [E.sessionAudit(sessionId)] },
  });

  if (history.isError && notForThisViewer(history.error)) return null;
  const entries = history.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <OrganiserCard testId="event-history" title={HISTORY_COPY.title} hint={HISTORY_COPY.hint}>
      {history.isLoading && <LoadingRows label="Loading the history" rows={3} />}
      {history.isError && <ErrorRow message={HISTORY_COPY.error} onRetry={() => history.refetch()} />}
      {!history.isLoading && !history.isError && entries.length === 0 && <EmptyRow testId="event-history-empty">{HISTORY_COPY.empty}</EmptyRow>}
      {entries.length > 0 && (
        <ol className="space-y-3">
          {entries.map((entry) => {
            const detail = historyDetail(entry);
            return (
              <li key={entry.id} data-testid="event-history-row" className="flex min-w-0 gap-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-500" aria-hidden="true">
                  <History className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[#1a1a2e] [overflow-wrap:anywhere]">{historySentence(entry)}</p>
                  {detail && <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">{detail}</p>}
                  <p className="text-xs text-gray-400"><time dateTime={entry.at}>{formatDateTime(entry.at)}</time></p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {history.hasNextPage && (
        <button type="button" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage} className={`${QUIET_BUTTON} mt-3`}>
          {HISTORY_COPY.older}
        </button>
      )}
    </OrganiserCard>
  );
}
