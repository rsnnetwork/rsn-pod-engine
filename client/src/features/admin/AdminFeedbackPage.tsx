// client/src/features/admin/AdminFeedbackPage.tsx
// Feedback after meetings, for admins (30 Oct 2026, item 5c: "Save the answers in the admin panel"). Every answer,
// newest first, thirty at a time: when, the two people (each opens the user inspector), worth continuing, the
// problems and the text, with the other person's answer about the same meeting beneath. A filter keeps only the
// answers with a problem; the CSV is the same rows (each download is logged on the server). A new answer appears
// without a reload: the list declares admin:meeting-feedback, which the server sends every admin on each save.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Download, Shield } from 'lucide-react';
import { MEETING_PROBLEM_LABELS, type AdminFeedbackPage as FeedbackPage, type AdminFeedbackPerson, type AdminFeedbackRow } from '@rsn/shared';
import { Skeleton } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { cn, isAdmin } from '@/lib/utils';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { errorMessage } from '@/features/reason/errors';
import { meetingWhen } from '@/features/meetings/meeting-words';

const PAGE = 30;
const BUTTON = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[11px] px-4 text-[14px] font-bold';
const SECONDARY = 'border border-reason-line bg-white text-[#2d3440] hover:bg-[#f5f6f7]';
const WORTH: Record<string, string> = { yes: 'Yes', maybe: 'Maybe', no: 'No' };
const COLUMNS = 'min-[1024px]:grid-cols-[150px_minmax(0,1.3fr)_96px_minmax(0,1fr)_minmax(0,1.6fr)]';

const fetchPage = (problemsOnly: boolean, cursor: string | null) =>
  api.get('/admin/feedback', { params: { limit: PAGE, ...(problemsOnly ? { problems: 'only' } : {}), ...(cursor ? { cursor } : {}) } })
    .then((r) => r.data.data as FeedbackPage);

const answeredOn = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const problemWords = (problems: AdminFeedbackRow['answer']['problems']) =>
  (problems.length ? problems.map((p) => MEETING_PROBLEM_LABELS[p]).join(', ') : 'None');

export default function AdminFeedbackPage() {
  const user = useAuthStore((s) => s.user);
  const admin = isAdmin(user?.role);
  const addToast = useToastStore((s) => s.addToast);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['admin-meeting-feedback', problemsOnly],
    queryFn: ({ pageParam }) => fetchPage(problemsOnly, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: admin,
    meta: { entities: [E.adminMeetingFeedback] },
  });

  if (!admin) {
    return (
      <div className="mx-auto max-w-md py-16 text-center font-reason text-reason-ink">
        <Shield aria-hidden="true" className="mx-auto h-10 w-10 text-reason-muted" />
        <h1 className="mt-3 text-[20px] font-bold">Admins only</h1>
        <p className="mt-1 text-[14px] text-reason-muted">This page is for the REASON team.</p>
        <Link to="/" className={cn(BUTTON, 'mt-4 bg-reason-red text-white hover:bg-reason-red-hover')}>Go home</Link>
      </div>
    );
  }

  const downloadCsv = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await api.get('/admin/feedback.csv', { params: problemsOnly ? { problems: 'only' } : {}, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `reason-meeting-feedback-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      addToast(errorMessage(err, 'We could not make the CSV. Try again in a moment.'), 'error');
    } finally {
      setDownloading(false);
    }
  };

  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  let body;
  if (list.isPending) body = <Loading />;
  else if (list.isError && rows.length === 0) body = <Failed message={errorMessage(list.error, 'Try again in a moment.')} onRetry={() => void list.refetch()} />;
  else if (rows.length === 0) body = <Empty problemsOnly={problemsOnly} />;
  else body = <FeedbackList rows={rows} />;

  return (
    <div className="mx-auto w-full max-w-[1100px] font-reason text-reason-ink">
      <header className="mb-4 flex flex-col gap-3 min-[721px]:flex-row min-[721px]:items-end min-[721px]:justify-between">
        <div className="min-w-0">
          <h1 className="text-[26px] font-extrabold tracking-[-0.03em]">Meeting feedback</h1>
          <p className="mt-1 text-[14px] text-reason-muted">What members said after their meetings. Only the REASON team sees this.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={problemsOnly}
            onClick={() => setProblemsOnly((v) => !v)}
            className={cn(BUTTON, problemsOnly ? 'border border-reason-red bg-reason-pink text-reason-red-hover' : SECONDARY)}
          >
            Only with problems
          </button>
          <button type="button" onClick={() => void downloadCsv()} aria-disabled={downloading || undefined} className={cn(BUTTON, SECONDARY, downloading && 'cursor-progress opacity-80')}>
            <Download aria-hidden="true" className="h-4 w-4" /> {downloading ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </header>
      {body}
      {list.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button type="button" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage} className={cn(BUTTON, SECONDARY)}>
            {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  );
}

function Person({ person }: { person: AdminFeedbackPerson }) {
  return (
    <Link
      to={`/admin/users/${encodeURIComponent(person.userId)}`}
      className={cn('inline-flex min-h-[44px] items-center font-bold [overflow-wrap:anywhere] hover:underline', person.isFormerMember && 'italic text-reason-muted')}
    >
      {person.displayName}
    </Link>
  );
}

function FeedbackList({ rows }: { rows: AdminFeedbackRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-reason-line bg-white">
      <div aria-hidden="true" className={cn('hidden gap-4 border-b border-reason-line bg-[#f7f8f9] px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#646a77] min-[1024px]:grid', COLUMNS)}>
        <span>Date</span><span>From → about</span><span>Worth it?</span><span>Problems</span><span>Text</span>
      </div>
      <ul className="divide-y divide-reason-line">
        {rows.map((r) => <FeedbackItem key={r.id} row={r} />)}
      </ul>
    </div>
  );
}

function Term({ children }: { children: string }) {
  return <span className="mr-1.5 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[#646a77] min-[1024px]:hidden">{children}</span>;
}

function FeedbackItem({ row }: { row: AdminFeedbackRow }) {
  const where = row.source === null ? 'Profile' : row.source === 'meeting' ? 'After a meeting' : row.source === 'instant' ? 'After a call' : 'After an event';
  return (
    <li data-testid="feedback-row" className={cn('grid gap-2 px-4 py-3.5 text-[14px] min-[1024px]:gap-4', COLUMNS)}>
      <div>
        <p className="font-bold">{answeredOn(row.answeredAt)}</p>
        <p className="text-[12px] text-reason-muted">{where}</p>
        {row.meeting && <p className="text-[12px] text-reason-muted">{meetingWhen(row.meeting.startAt, row.meeting.durationMin)} · {row.meeting.kind === 'audio' ? 'Audio' : 'Video'}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-x-2">
        <Person person={row.from} /> <span aria-label="about" className="text-reason-muted">→</span> <Person person={row.about} />
      </div>
      <p><Term>Worth it?</Term>{WORTH[row.answer.worthContinuing]}</p>
      <p><Term>Problems</Term>{problemWords(row.answer.problems)}</p>
      <div className="min-w-0">
        <p className="whitespace-pre-line [overflow-wrap:anywhere]"><Term>Text</Term>{row.answer.problemText ?? '—'}</p>
        {row.meeting && (
          <p className="mt-1.5 text-[12px] text-reason-muted [overflow-wrap:anywhere]">
            {row.theirAnswer
              ? `${row.about.displayName} said: ${WORTH[row.theirAnswer.worthContinuing]} · ${problemWords(row.theirAnswer.problems)}`
              : `${row.about.displayName} has not answered.`}
          </p>
        )}
      </div>
    </li>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="space-y-2">
      <p className="sr-only">Loading the feedback</p>
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)}
    </div>
  );
}

function Empty({ problemsOnly }: { problemsOnly: boolean }) {
  return (
    <div className="rounded-2xl border border-reason-line bg-white p-6 text-center">
      <p className="text-[15px] font-bold">{problemsOnly ? 'No feedback with problems yet.' : 'No feedback yet.'}</p>
      <p className="mt-1 text-[13px] text-reason-muted">Answers appear here as members leave their meetings.</p>
    </div>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-reason-line bg-white p-5">
      <div>
        <h2 className="text-[17px] font-bold">We could not load the feedback just now.</h2>
        <p className="mt-1 text-[14px] text-reason-muted">{message}</p>
      </div>
      <button type="button" onClick={onRetry} className={cn(BUTTON, 'bg-reason-red text-white hover:bg-reason-red-hover')}>Try again</button>
    </div>
  );
}
