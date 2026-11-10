// Preview and publish (spec 06, 07 "Publish control"): the draft stays the organisers' own until it is published as a
// numbered version. The preview lists what blocks publishing first, then what is worth a look, and how many people
// will be told their meetings changed; "Publish version {n}" freezes the board; the versions list keeps every one.
import { useState } from 'react';
import { CheckCircle2, CircleAlert, AlertTriangle, Loader2 } from 'lucide-react';
import type { ScheduleBoard } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Skeleton } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { boardErrorOf } from './board-errors';
import { roomTitle, startsAtLabel } from './board-model';
import { publishCopy, usePublish, usePublishPreview, useScheduleVersions, type PublishItem } from './publish-api';

interface Props {
  sessionId: string;
  board: ScheduleBoard;
  open: boolean;
  onClose: () => void;
  applyReturnedBoard: (board: ScheduleBoard) => void;
}

function Items({ items, tone }: { items: PublishItem[]; tone: 'problem' | 'warning' }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1.5">
      {items.map((item, i) => (
        <li key={`${item.round}-${item.room}-${i}`} className="flex items-start gap-2 text-[13px] leading-snug text-[#3d4a55]">
          {tone === 'problem'
            ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />}
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="font-semibold">Round {item.round}{item.room ? `, ${roomTitle(item.room)}` : ''}: </span>{item.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function PublishPanel({ sessionId, board, open, onClose, applyReturnedBoard }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const preview = usePublishPreview(sessionId, open);
  const versions = useScheduleVersions(sessionId, open);
  const publish = usePublish(sessionId, applyReturnedBoard);
  const [note, setNote] = useState('');
  const [published, setPublished] = useState<number | null>(null);
  const data = preview.data;
  const blocked = !data || data.blocking.length > 0;

  const submit = () => publish.mutate(note.trim() || undefined, {
    onSuccess: (result) => {
      setPublished(result.version);
      setNote('');
      addToast(publishCopy.published(result.version), 'success');
    },
    onError: (err) => addToast(boardErrorOf(err).message, 'error'),
  });

  const status = board.publishedVersion === null
    ? 'Nothing is published yet. People see their meetings once you publish.'
    : `Version ${board.publishedVersion} is published.${board.draftDiffersFromPublished ? ' The board has changed since.' : ' The board matches it.'}`;

  return (
    <Sheet open={open} onClose={onClose} title={publishCopy.title}>
      <p className="text-[14px] text-[#5a6670]">{status}</p>
      {published !== null && (
        <p data-testid="publish-done" className="mt-3 flex items-center gap-2 rounded-xl bg-[#e3f1ee] px-3 py-2 text-[14px] font-semibold text-[#1d6b5c]">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {publishCopy.published(published)}
        </p>
      )}

      <div className="mt-4" data-testid="publish-preview">
        {preview.isLoading && <div className="flex flex-col gap-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div>}
        {preview.isError && (
          <div className="rounded-xl bg-red-50 px-3 py-2 text-[14px] text-red-800">
            {publishCopy.loadFailed}
            <button type="button" onClick={() => void preview.refetch()} className="ml-2 inline-flex min-h-[44px] items-center font-semibold underline">Try again</button>
          </div>
        )}
        {data && (
          <>
            {data.blocking.length > 0 && (
              <section className="rounded-xl border border-red-200 bg-red-50/60 p-3">
                <h3 className="text-[13px] font-bold text-red-800">{publishCopy.blockingTitle}</h3>
                <Items items={data.blocking} tone="problem" />
              </section>
            )}
            {data.warnings.length > 0 && (
              <section className={cn('rounded-xl border border-amber-200 bg-amber-50/60 p-3', data.blocking.length > 0 && 'mt-2')}>
                <h3 className="text-[13px] font-bold text-amber-900">{publishCopy.warningsTitle}</h3>
                <Items items={data.warnings} tone="warning" />
              </section>
            )}
            {data.blocking.length === 0 && data.warnings.length === 0 && (
              <p className="flex items-center gap-2 text-[14px] text-[#1d6b5c]"><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {publishCopy.clean}</p>
            )}
            <p data-testid="publish-impacted" className="mt-3 text-[14px] text-[#3d4a55]">{publishCopy.impacted(data.impactedUserIds.length)}</p>
            <label htmlFor="publish-note" className="mt-3 block text-[13px] font-semibold text-[#3d4a55]">Note for the history (optional)</label>
            <input
              id="publish-note"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-xl border border-[#cfd6db] px-3 text-[16px] sm:text-[14px]"
            />
            <button
              type="button"
              onClick={submit}
              disabled={blocked || publish.isPending}
              className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[#12293a] px-4 text-[14px] font-bold text-white disabled:opacity-50 sm:w-auto"
            >
              {publish.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {publishCopy.publishVersion(data.nextVersion)}
            </button>
          </>
        )}
      </div>

      <section className="mt-6 border-t border-[#e3e7ea] pt-4" aria-label={publishCopy.versionsTitle}>
        <h3 className="text-[13px] font-bold text-[#12293a]">{publishCopy.versionsTitle}</h3>
        {versions.isLoading && <Skeleton className="mt-2 h-5 w-1/2" />}
        {versions.isError && <p className="mt-2 text-[14px] text-[#5a6670]">We couldn't load the versions.</p>}
        {versions.data && versions.data.length === 0 && <p className="mt-2 text-[14px] text-[#5a6670]">{publishCopy.noVersions}</p>}
        {versions.data && versions.data.length > 0 && (
          <ol className="mt-2 flex flex-col gap-1.5" data-testid="publish-versions">
            {versions.data.map((v) => (
              <li key={v.version} className="text-[14px] text-[#3d4a55] [overflow-wrap:anywhere]">
                <span className="font-semibold text-[#12293a]">Version {v.version}</span>
                {[
                  startsAtLabel(v.publishedAt),
                  v.automatic ? publishCopy.automatic : v.publishedByName && `by ${v.publishedByName}`,
                  v.reason,
                  v.impactedCount !== null ? `${v.impactedCount} ${v.impactedCount === 1 ? 'person' : 'people'} told` : null,
                ].filter(Boolean).map((part) => ` · ${part}`).join('')}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Sheet>
  );
}
