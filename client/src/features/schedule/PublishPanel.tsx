// Preview and publish (spec 06, 07 "Publish control"): the draft stays the organisers' own until it is published as a
// numbered version. The preview lists what blocks publishing first, then what is worth a look, and how many people
// will be told their meetings changed; "Publish version {n}" freezes the board; the versions list keeps every one.
import { useState } from 'react';
import { CheckCircle2, CircleAlert, AlertTriangle, Loader2 } from 'lucide-react';
import type { PublishPreviewItem, ScheduleBoard } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Skeleton } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { boardErrorOf } from './board-errors';
import { roomTitle, startsAtLabel } from './board-model';
import {
  hasSomethingToPublish, publishCopy, usePublish, usePublishPreview, useScheduleVersions, versionLine, wasUnchanged,
} from './publish-api';

interface Props {
  sessionId: string;
  board: ScheduleBoard;
  open: boolean;
  onClose: () => void;
  applyReturnedBoard: (board: ScheduleBoard) => void;
}

function Items({ items, tone }: { items: PublishPreviewItem[]; tone: 'problem' | 'warning' }) {
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
  const [done, setDone] = useState<string | null>(null);
  const data = preview.data;
  const somethingToPublish = hasSomethingToPublish(board);
  const blocked = !data || data.blocking.length > 0 || !somethingToPublish;

  // A reopened panel starts from the board as it is, not from the last publish's outcome.
  const close = () => { setDone(null); onClose(); };

  const submit = () => publish.mutate(note.trim() || undefined, {
    onSuccess: ({ result, sentRevision }) => {
      // A draft equal to the latest version writes nothing (and settles live conflicts): it is said so, not as a new version.
      const said = wasUnchanged(result, sentRevision) ? publishCopy.unchanged(result.version) : publishCopy.published(result.version);
      setDone(said);
      setNote('');
      addToast(said, 'success');
    },
    onError: (err) => addToast(boardErrorOf(err).message, 'error'),
  });

  const status = board.publishedVersion === null
    ? 'Nothing is published yet. People see their meetings once you publish.'
    : `Version ${board.publishedVersion} is published.${board.draftDiffersFromPublished ? ' The board has changed since.' : ' The board matches it.'}`;

  return (
    <Sheet open={open} onClose={close} title={publishCopy.title}>
      <p className="text-[14px] text-[#5a6670]">{status}</p>
      {done !== null && (
        <p data-testid="publish-done" role="status" className="mt-3 flex items-center gap-2 rounded-xl bg-[#e3f1ee] px-3 py-2 text-[14px] font-semibold text-[#1d6b5c]">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {done}
        </p>
      )}
      {board.liveConflicts.length > 0 && (
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[14px] text-red-800">
          The live event changed {board.liveConflicts.length === 1 ? 'a room' : `${board.liveConflicts.length} rooms`} where your draft has its own seating.
          Publishing makes your draft the plan and settles {board.liveConflicts.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {!somethingToPublish && board.publishedVersion !== null && done === null && (
        <p data-testid="publish-nothing" className="mt-3 text-[14px] text-[#3d4a55]">{publishCopy.matches(board.publishedVersion)}</p>
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
                {` · ${versionLine(v, startsAtLabel(v.publishedAt))}`}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Sheet>
  );
}
