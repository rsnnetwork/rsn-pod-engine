// ─── "Delete this event permanently?": typed name to confirm (Part 2 Task 11; spec 11) ──────────────────────────────
// A super admin's step (the server's allowedActions offers it to nobody else). The confirm button stays disabled until
// the typed name is the event's (trimmed, any case, as the server compares it). Portalled through Sheet.
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import Sheet from '@/features/reason/ui/Sheet';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { organiserSentence } from '../organiser-errors';
import { FIELD, FieldError, LABEL, QUIET_BUTTON, SOLID_DANGER_BUTTON, fieldBorder } from '../organiser-ui';
import { LIFECYCLE_COPY, titleMatches } from './lifecycle-text';

interface Props {
  open: boolean;
  busy: boolean;
  /** The event's name, which the organiser types. */
  title: string;
  onClose: () => void;
  onConfirm: (typed: string) => Promise<unknown>;
}

type DeleteValues = { confirmTitle: string };

export default function DeleteEventDialog({ open, busy, title, onClose, onConfirm }: Props) {
  const formId = useId();
  const fieldId = useId();
  const errorId = useId();
  const schema = z.object({
    confirmTitle: z.string().refine((typed) => titleMatches(typed, title), LIFECYCLE_COPY.nameMismatch),
  });
  const form = useForm<DeleteValues>({ defaultValues: { confirmTitle: '' }, resolver: formResolver(schema) });
  const { reset } = form;
  useEffect(() => { if (open) reset({ confirmTitle: '' }); }, [open, reset]);

  const typed = form.watch('confirmTitle');
  const matches = titleMatches(typed, title);
  const submit = form.handleSubmit(async ({ confirmTitle }) => {
    try {
      await onConfirm(confirmTitle);
    } catch (err) {
      form.setError('confirmTitle', { type: 'server', message: organiserSentence(err, LIFECYCLE_COPY.fallback) });
    }
  });
  const error = form.formState.errors.confirmTitle?.message;
  const close = () => { if (!busy) onClose(); };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={LIFECYCLE_COPY.deleteTitle}
      footer={(
        <>
          <button type="button" onClick={close} disabled={busy} className={QUIET_BUTTON}>Cancel</button>
          <button
            type="submit"
            form={formId}
            disabled={busy || !matches}
            data-testid="lifecycle-delete-confirm"
            className={SOLID_DANGER_BUTTON}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {LIFECYCLE_COPY.deletePermanently}
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-3 pb-1">
        <p className="mt-1 text-sm leading-relaxed text-gray-600">{LIFECYCLE_COPY.deleteBody}</p>
        <p className="rounded-xl bg-gray-50 px-3 py-2 text-sm font-semibold text-[#1a1a2e] [overflow-wrap:anywhere]">{title}</p>
        <div>
          <label htmlFor={fieldId} className={LABEL}>{LIFECYCLE_COPY.nameLabel}</label>
          <input
            id={fieldId}
            data-testid="lifecycle-delete-name"
            autoComplete="off"
            aria-invalid={!!error || undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(FIELD, fieldBorder(error))}
            {...form.register('confirmTitle')}
          />
          <FieldError id={errorId} message={error} />
        </div>
      </form>
    </Sheet>
  );
}
