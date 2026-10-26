import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { CheckCircle2, Loader2, MessageSquareText, Send, X } from 'lucide-react';
import { POST_EVENT_MESSAGE_LIMITS } from '@rsn/shared';
import type { BroadcastAudience } from '@rsn/shared';
import Modal from '@/components/ui/Modal';
import { formResolver } from '@/lib/form-resolver';
import { useBroadcastEligibilityV2, usePostEventMessageStatus, useSendPostEventMessage } from './usePostEventMessage';
import {
  CHECK_FAILED, MESSAGE_LABEL, NO_SHOWS_LABEL, PANEL_INTRO, PANEL_TITLE, TOOK_PART_LABEL,
  composerSchema, panelView, recipientsOf, sendErrorSentence, sendLabel, type ComposerValues,
} from './post-event-panel';

// ─── "Message everyone who took part" on a completed event's page (26 Oct 2026, C10, COM-03) ───
//
// Replaces MessageParticipantsButton, a greyed-out button whose reason lived in a hover title (Claus, 25 Oct). A card
// for the people who run the event: where things stand, always as text (post-event-panel.ts), and, when a send would
// be accepted, one button that opens the composer for their own words. Its state follows the event's tag (no poll).

const BUTTON = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const CARD = 'rounded-2xl border border-gray-200 bg-white p-5 shadow-sm';

export default function MessageParticipantsPanel({ sessionId }: { sessionId: string }) {
  const eligibility = useBroadcastEligibilityV2(sessionId);
  const status = usePostEventMessageStatus(sessionId, !!eligibility.data?.visible);
  const [composing, setComposing] = useState(false);

  if (eligibility.isPending) {
    return (
      <div data-testid="message-everyone-loading" className={CARD} aria-busy="true">
        <div className="h-4 w-56 max-w-full animate-pulse rounded bg-gray-200" />
        <div className="mt-3 h-3 w-full animate-pulse rounded bg-gray-100" />
        <div className="mt-4 h-11 w-44 max-w-full animate-pulse rounded-xl bg-gray-100" />
      </div>
    );
  }
  if (eligibility.isError) {
    return (
      <section data-testid="message-everyone-error" className={CARD}>
        <p className="text-sm text-gray-700">{CHECK_FAILED}</p>
        <button
          type="button"
          onClick={() => { void eligibility.refetch(); }}
          className={`${BUTTON} mt-3 w-full border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 sm:w-auto`}
        >
          Try again
        </button>
      </section>
    );
  }

  const view = panelView(eligibility.data, status.data);
  if (!view.show) return null;
  const sending = eligibility.data.reason === 'sending';

  return (
    <section data-testid="message-everyone" aria-labelledby="message-everyone-title" className={CARD}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rsn-red/10">
          <MessageSquareText className="h-5 w-5 text-rsn-red" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="message-everyone-title" className="text-base font-semibold text-[#1a1a2e]">{PANEL_TITLE}</h2>
          <p className="mt-1 text-sm text-gray-500">{PANEL_INTRO}</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 empty:hidden" aria-live="polite">
        {view.status && (
          <p data-testid="message-everyone-status" className="flex items-center gap-2 text-sm font-medium text-gray-800">
            {sending && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-gray-500" aria-hidden="true" />}
            {view.status}
          </p>
        )}
        {view.sent && (
          <p data-testid="message-everyone-sent" className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{view.sent}</span>
          </p>
        )}
        {view.problem && <p role="alert" className="text-sm text-red-600">{view.problem}</p>}
      </div>

      {view.action && (
        <button
          type="button"
          onClick={() => setComposing(true)}
          className={`${BUTTON} mt-4 w-full bg-rsn-red text-white hover:bg-rsn-red-hover sm:w-auto`}
        >
          <Send className="h-4 w-4" aria-hidden="true" /> {view.action}
        </button>
      )}

      <Composer sessionId={sessionId} audience={eligibility.data.audience} open={composing} onClose={() => setComposing(false)} />
    </section>
  );
}

/** The organiser's message, who gets it, and Send. The words stay if a send is refused; the reason shows beside them. */
function Composer({ sessionId, audience, open, onClose }: {
  sessionId: string;
  audience: BroadcastAudience;
  open: boolean;
  onClose: () => void;
}) {
  const send = useSendPostEventMessage(sessionId);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<ComposerValues>({
    defaultValues: { body: '', includeNoShows: false },
    resolver: formResolver(composerSchema),
  });
  const body = watch('body') ?? '';
  const total = recipientsOf(audience, watch('includeNoShows'));

  const close = () => {
    if (send.isPending) return;
    setRefusal(null);
    onClose();
  };
  const submit = handleSubmit((values) => {
    setRefusal(null);
    send.mutate(values, {
      onSuccess: () => { reset(); onClose(); },
      onError: (err) => setRefusal(sendErrorSentence(err)),
    });
  });

  return (
    <Modal open={open} onClose={close} className="max-w-lg">
      <div role="dialog" aria-modal="true" aria-labelledby="compose-everyone-title" className="pt-4">
        <form onSubmit={submit} noValidate data-testid="message-everyone-composer">
          <div className="flex items-center justify-between gap-2">
            <h2 id="compose-everyone-title" className="text-lg font-semibold text-[#1a1a2e]">{PANEL_TITLE}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="-mr-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
  
          <label htmlFor="compose-everyone-body" className="mt-3 block text-sm font-medium text-gray-700">{MESSAGE_LABEL}</label>
          <textarea
            id="compose-everyone-body"
            rows={6}
            maxLength={POST_EVENT_MESSAGE_LIMITS.bodyMax}
            aria-invalid={errors.body ? true : undefined}
            aria-describedby="compose-everyone-count compose-everyone-error"
            placeholder="Thank everyone for coming, share what happens next…"
            {...register('body')}
            // 16px on every width, so iOS does not zoom in on the box.
            className="mt-1.5 block w-full resize-y rounded-xl border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red/30"
          />
          <div className="mt-1 flex items-start justify-between gap-3 text-xs">
            <p id="compose-everyone-error" role={errors.body ? 'alert' : undefined} className="text-red-600">{errors.body?.message}</p>
            <p id="compose-everyone-count" className="shrink-0 tabular-nums text-gray-500">{body.length} / {POST_EVENT_MESSAGE_LIMITS.bodyMax}</p>
          </div>
  
          <fieldset className="mt-3">
            <legend className="text-sm font-medium text-gray-700">Who gets it</legend>
            <p className="mt-1 flex min-h-[44px] items-center gap-3 text-sm text-gray-800">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" /><span>{TOOK_PART_LABEL} ({audience.tookPart})</span>
            </p>
            {audience.registeredNoShow > 0 && (
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-gray-800">
                <input type="checkbox" {...register('includeNoShows')} className="h-5 w-5 shrink-0 rounded border-gray-300 accent-rsn-red" />
                {NO_SHOWS_LABEL} ({audience.registeredNoShow})
              </label>
            )}
          </fieldset>
  
          {refusal && <p role="alert" data-testid="message-everyone-refusal" className="mt-3 text-sm text-red-600">{refusal}</p>}
  
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={close} className={`${BUTTON} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>
              Cancel
            </button>
            <button type="submit" disabled={send.isPending} className={`${BUTTON} bg-rsn-red text-white hover:bg-rsn-red-hover`}>
              {send.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <Send className="h-4 w-4" aria-hidden="true" />}
              {sendLabel(total)}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
