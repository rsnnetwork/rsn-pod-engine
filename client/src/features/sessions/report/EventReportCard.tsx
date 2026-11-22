// ─── The event report on the event page, once it is over (10 Nov 2026 spec 03 "Reporting"; Part 3 Task 9) ──────────
// For the people running the event only (the page shows it with the other after-event tools): the six summary
// figures, the three spreadsheet downloads and a link to the full report. Anyone the server refuses (403) or an event
// it does not know (404) gets nothing drawn at all.
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { notForThisViewer } from '../organiser-errors';
import { EmptyRow, ErrorRow, LoadingRows, OrganiserCard, PRIMARY_BUTTON } from '../organiser-ui';
import { ReportDownloads, ReportTiles } from './report-parts';
import { REPORT_COPY } from './report-text';
import { useEventReport, useReportDownloads } from './useEventReport';

export default function EventReportCard({ sessionId }: { sessionId: string }) {
  const report = useEventReport(sessionId);
  const { download, busy } = useReportDownloads(sessionId, report.data);

  if (report.isError && notForThisViewer(report.error)) return null;
  const data = report.data;

  return (
    <OrganiserCard testId="event-report" title={REPORT_COPY.cardTitle} hint={REPORT_COPY.cardHint}>
      {report.isLoading && <LoadingRows label={REPORT_COPY.loading} rows={3} />}
      {report.isError && <ErrorRow message={REPORT_COPY.error} onRetry={() => void report.refetch()} />}
      {data && (
        <div className="space-y-4">
          {data.summary.registered === 0
            ? <EmptyRow testId="event-report-empty">{REPORT_COPY.emptyPeople}</EmptyRow>
            : <ReportTiles summary={data.summary} />}
          <ReportDownloads busy={busy} onDownload={(section) => void download(section)} />
          <Link
            to={`/sessions/${sessionId}/report`}
            data-testid="event-report-open"
            className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
          >
            <FileText className="h-4 w-4" aria-hidden="true" /> {REPORT_COPY.open}
          </Link>
        </div>
      )}
    </OrganiserCard>
  );
}
