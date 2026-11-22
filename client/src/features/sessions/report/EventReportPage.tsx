// ─── The full event report: /sessions/:sessionId/report (10 Nov 2026 spec 03 "Reporting"; Part 3 Task 9) ──────────
// For the people running the event (its host, co-hosts and moderators, its pod's director or host, admins). The
// summary, how the meetings went (aggregates only, withheld under five ratings), the three downloads, then
// attendance, rounds and mutual matches as stacked cards. Every time is on the event's own clock with the zone named.
// Anyone else is told the report is not for them and sees none of it; the server refuses them anyway (403).
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { timeZoneLabel } from '@/lib/event-time';
import { ErrorRow, LoadingRows, OrganiserCard } from '../organiser-ui';
import { ReportDownloads, ReportTiles } from './report-parts';
import { AttendanceSection, MutualSection, RoundsSection } from './ReportSections';
import { REPORT_COPY, ratingLines, reportWhen } from './report-text';
import { useEventReport, useReportDownloads } from './useEventReport';

const BACK_LINK = 'inline-flex min-h-[44px] items-center gap-2 text-sm text-gray-500 hover:text-gray-800 transition-colors';

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null ? (err as { response?: { status?: number } }).response?.status : undefined;
}

export default function EventReportPage() {
  const { sessionId = '' } = useParams();
  const report = useEventReport(sessionId);
  const { download, busy } = useReportDownloads(sessionId, report.data);
  const data = report.data;
  const refused = statusOf(report.error);

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 space-y-4 px-4 py-6 sm:py-8">
      <Link to={`/sessions/${sessionId}`} className={BACK_LINK}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {REPORT_COPY.back}
      </Link>

      {report.isLoading && <LoadingRows label={REPORT_COPY.loading} rows={6} />}
      {(refused === 403 || refused === 404) && (
        <p data-testid="event-report-unavailable" role="status" className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-gray-600">
          {refused === 403 ? REPORT_COPY.notAvailable : REPORT_COPY.notFound}
        </p>
      )}
      {report.isError && refused !== 403 && refused !== 404 && (
        <ErrorRow message={REPORT_COPY.error} onRetry={() => void report.refetch()} />
      )}

      {data && (
        <>
          <header className="min-w-0">
            <h1 className="text-2xl font-bold text-[#1a1a2e]">{REPORT_COPY.pageTitle}</h1>
            <p className="text-base font-medium text-gray-700 [overflow-wrap:anywhere]">{data.event.title}</p>
            {reportWhen(data) && <p data-testid="event-report-when" className="text-sm text-gray-500">{reportWhen(data)}</p>}
            <p className="text-xs text-gray-400">Times are shown in {timeZoneLabel(data.event.timezone)}.</p>
          </header>

          <OrganiserCard testId="report-summary" title={REPORT_COPY.howItWent}>
            <div className="space-y-4">
              <ReportTiles summary={data.summary} />
              <dl className="divide-y divide-gray-100 text-sm">
                {ratingLines(data.summary).map((line) => (
                  <div key={line.label} className="flex flex-wrap justify-between gap-x-3 py-2">
                    <dt className="text-gray-600">{line.label}</dt>
                    <dd className="font-medium text-[#1a1a2e]">{line.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </OrganiserCard>

          <OrganiserCard testId="report-downloads" title={REPORT_COPY.downloads}>
            <ReportDownloads busy={busy} onDownload={(section) => void download(section)} />
          </OrganiserCard>

          <AttendanceSection report={data} />
          <RoundsSection report={data} />
          <MutualSection report={data} />
        </>
      )}
    </div>
  );
}
