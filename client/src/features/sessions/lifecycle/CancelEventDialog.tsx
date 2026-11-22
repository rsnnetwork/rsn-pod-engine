// ─── "Cancel this event?" with an optional reason (Part 2 Task 11; spec 11) ──────────────────────────────────────────
// Asked before anything is sent: everyone registered is emailed and notified, with the reason if one is given. A
// Sheet, so it is portalled to <body> (a bottom sheet on a phone, a dialog from 768px). The form holds while it sends,
// and a refusal is said under the field.
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { EVENT_CANCEL_REASON_MAX } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { organiserSentence } from '../organiser-errors';
import { FIELD, FieldError, LABEL, QUIET_BUTTON, SOLID_DANGER_BUTTON, fieldBorder } from '../organiser-ui';
import { LIFECYCLE_COPY } from './lifecycle-text';

const cancelSchema = z.object({
  reason: z.string().max(EVENT_CANCEL_REASON_MAX, LIFECYCLE_COPY.reasonTooLong),
});
type CancelValues = z.infer<typeof cancelSchema>;

interface Props {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  /** Resolves when the event is cancelled; rejects with the server's refusal. */
  onConfirm: (reason: string) => Promise<unknown>;
}

export default function CancelEventDialog({ open, busy, onClose, onConfirm }: Props) {
  const formId = useId();
  const fieldId = useId();
  const errorId = useId();
  const form = useForm<CancelValues>({ defaultValues: { reason: '' }, resolver: formResolver(cancelSchema) });
  const { reset } = form;
  useEffect(() => { if (open) reset({ reason: '' }); }, [open, reset]);

  const submit = form.handleSubmit(async ({ reason }) => {
    try {
      await onConfirm(reason);
    } catch (err) {
      form.setError('reason', { type: 'server', message: organiserSentence(err, LIFECYCLE_COPY.fallback) });
    }
  });
  const error = form.formState.errors.reason?.message;
  const length = form.watch('reason').length;
  const close = () => { if (!busy) onClose(); };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={LIFECYCLE_COPY.cancelTitle}
      footer={(
        <>
          <button type="button" onClick={close} disabled={busy} className={QUIET_BUTTON}>{LIFECYCLE_COPY.keep}</button>
          <button
            type="submit"
            form={formId}
            disabled={busy}
            data-testid="lifecycle-cancel-confirm"
            className={SOLID_DANGER_BUTTON}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {LIFECYCLE_COPY.cancel}
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-3 pb-1">
        <p className="mt-1 text-sm leading-relaxed text-gray-600">{LIFECYCLE_COPY.cancelBody}</p>
        <div>
          <label htmlFor={fieldId} className={LABEL}>{LIFECYCLE_COPY.reasonLabel}</label>
          <textarea
            id={fieldId}
            data-testid="lifecycle-cancel-reason"
            rows={3}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(FIELD, fieldBorder(error), 'resize-none')}
            {...form.register('reason')}
          />
          <div className="flex items-start justify-between gap-2">
            <FieldError id={errorId} message={error} />
            <p className="ml-auto mt-1 text-xs text-gray-400">{length}/{EVENT_CANCEL_REASON_MAX}</p>
          </div>
        </div>
      </form>
    </Sheet>
  );
}
