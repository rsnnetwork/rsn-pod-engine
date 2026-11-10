// ─── "RSN Call link": the event's one shareable link, for its organisers (Part 2 Task 11; spec 02, 04) ──────────────
// Anyone with the link reaches the event's entry (who gets a place is still the event's admission). Copy link puts it
// on the clipboard; Make a new link asks first, because the old link stops working at once. The link is read through
// call-link.ts; until the server has the call-link routes the card draws nothing.
import { useState } from 'react';
import { Check, Copy, Link2, RefreshCw } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import { callLinkAddress, useCallLink, useRotateCallLink } from './call-link';
import { notForThisViewer, organiserSentence } from './organiser-errors';
import { ErrorRow, LoadingRows, OrganiserCard, PRIMARY_BUTTON, QUIET_BUTTON } from './organiser-ui';

export const CALL_LINK_COPY = {
  title: 'RSN Call link',
  hint: 'Share it anywhere. People open it to join this event; who gets a place still follows Admission below.',
  draftNote: 'The link works once the event is published.',
  copy: 'Copy link',
  copied: 'Copied',
  copyFailed: 'The link could not be copied. Select it and copy it yourself.',
  rotate: 'Make a new link',
  rotateTitle: 'Make a new link?',
  rotateBody: 'The old link stops working at once.',
  rotated: 'A new link is ready. The old one no longer works.',
  error: 'The call link could not be read just now.',
  fallback: 'That did not go through. Please try again.',
} as const;

export default function CallLinkCard({ sessionId, isDraft }: { sessionId: string; isDraft: boolean }) {
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const link = useCallLink(sessionId, true);
  const rotate = useRotateCallLink(sessionId);
  const [copied, setCopied] = useState(false);

  if (link.isError && notForThisViewer(link.error)) return null;
  const address = link.data ? callLinkAddress(link.data, window.location.origin) : null;

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast(CALL_LINK_COPY.copyFailed, 'error');
    }
  };

  const makeNew = async () => {
    if (!(await ask({ title: CALL_LINK_COPY.rotateTitle, body: CALL_LINK_COPY.rotateBody, confirmLabel: CALL_LINK_COPY.rotate, tone: 'danger' }))) return;
    rotate.mutate(undefined, {
      onSuccess: () => addToast(CALL_LINK_COPY.rotated, 'success'),
      onError: (err) => addToast(organiserSentence(err, CALL_LINK_COPY.fallback), 'error'),
    });
  };

  return (
    <OrganiserCard testId="call-link-card" title={CALL_LINK_COPY.title} hint={CALL_LINK_COPY.hint}>
      {link.isLoading && <LoadingRows label="Loading the call link" rows={1} />}
      {link.isError && <ErrorRow message={CALL_LINK_COPY.error} onRetry={() => link.refetch()} />}
      {address && (
        <div className="space-y-3">
          <div className="flex min-w-0 items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
            <Link2 className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
            <span data-testid="call-link-address" className="min-w-0 select-all text-sm text-[#1a1a2e] [overflow-wrap:anywhere]">{address}</span>
          </div>
          {isDraft && <p className="text-sm text-amber-700">{CALL_LINK_COPY.draftNote}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="call-link-copy" onClick={() => void copy()} className={PRIMARY_BUTTON}>
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              <span aria-live="polite">{copied ? CALL_LINK_COPY.copied : CALL_LINK_COPY.copy}</span>
            </button>
            <button type="button" data-testid="call-link-rotate" onClick={() => void makeNew()} disabled={rotate.isPending} className={QUIET_BUTTON}>
              <RefreshCw className={rotate.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />
              {CALL_LINK_COPY.rotate}
            </button>
          </div>
        </div>
      )}
      {confirmDialog}
    </OrganiserCard>
  );
}
