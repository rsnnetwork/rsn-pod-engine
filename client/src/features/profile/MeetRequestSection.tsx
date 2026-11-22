// "Your meeting request" on Edit profile (Stefan, 21 Nov 2026): the note every meeting request of the member's starts
// with, and the format it proposes. The Meet sheet opens on both (still changeable for each request). Its own form and
// its own Save, beside the profile form: it saves only these two, so it never writes over the profile's fields.
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { MEET_NOTE_MAX, MEETING_FORMATS } from '@rsn/shared';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { errorMessage } from '@/features/reason/errors';
import { FIRST_NAME_TOKEN, MEET_NOTE_EXAMPLE } from '@/features/reason/human/meet-note';
import { meetDefaultsKey, useMeetDefaults } from '@/features/reason/human/useMeetDefaults';
import {
  MEET_REQUEST_SAVE_FAILED, meetRequestBody, meetRequestFieldError, meetRequestSchema, meetRequestValues,
  type MeetRequestValues,
} from './meet-request-form';

const FIELD = 'w-full rounded-xl border bg-gray-50 px-4 py-2.5 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] sm:text-sm';

export default function MeetRequestSection() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const userId = useAuthStore((s) => s.user?.id as string | undefined);
  const saved = useMeetDefaults();
  const noteId = useId();
  const counterId = useId();
  const hintId = useId();
  const noteErrorId = useId();
  const formatId = useId();
  const formatErrorId = useId();

  const form = useForm<MeetRequestValues>({ defaultValues: meetRequestValues(undefined), resolver: formResolver(meetRequestSchema) });
  const { register, handleSubmit, reset, setError, setValue, watch, formState: { errors, isDirty } } = form;

  // The form follows what is saved (a save made on another device arrives as user:<you>) until the member starts
  // changing it; their unsaved words are never put back.
  const { data } = saved;
  useEffect(() => {
    if (data && !form.formState.isDirty) reset(meetRequestValues(data));
  }, [data, form, reset]);

  const save = useMutation({
    mutationFn: (values: MeetRequestValues) => api.put('/users/me', meetRequestBody(values)),
    onSuccess: (_res, values) => {
      reset(values, { keepValues: true });
      addToast('Your meeting request is saved.', 'success');
      // Returned, so Save stays busy until the saved values are read back.
      return qc.invalidateQueries({ queryKey: meetDefaultsKey(userId) });
    },
    onError: (err) => {
      const field = meetRequestFieldError(err);
      if (field) setError(field.field, { type: 'server', message: field.message }, { shouldFocus: true });
      else addToast(errorMessage(err, MEET_REQUEST_SAVE_FAILED), 'error');
    },
  });

  const note = watch('note') ?? '';
  const length = note.trim().length;
  const over = length > MEET_NOTE_MAX;
  const submit = handleSubmit((values) => { if (!save.isPending) save.mutate(values); });

  return (
    <Card className="animate-fade-in-up" data-testid="meet-request-section">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-gray-800">
        <Send className="h-5 w-5 text-rsn-red" aria-hidden="true" /> Your meeting request
      </h2>
      <p className="mb-4 text-xs text-gray-500">
        Every meeting request you send starts with this message and format. You can still change both each time you send one.
      </p>

      {saved.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only" role="status">Loading your meeting request</span>
          <Skeleton className="h-[120px] rounded-xl" />
          <Skeleton className="h-[44px] rounded-xl" />
        </div>
      ) : saved.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-700">We could not load your meeting request just now.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void saved.refetch()} className="min-h-[44px]">Try again</Button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <div>
            <label htmlFor={noteId} className="mb-1.5 block text-sm font-medium text-gray-600">Your standard message</label>
            <textarea
              id={noteId}
              rows={4}
              placeholder={MEET_NOTE_EXAMPLE}
              aria-invalid={errors.note || over ? true : undefined}
              aria-describedby={[counterId, hintId, errors.note ? noteErrorId : null].filter(Boolean).join(' ')}
              {...register('note')}
              className={cn(FIELD, 'min-h-[110px] resize-y leading-relaxed', errors.note || over ? 'border-rsn-red' : 'border-gray-200')}
            />
            <div className="mt-1 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <p id={hintId} className="min-w-0 flex-1 text-xs text-gray-500 [overflow-wrap:anywhere]">
                Write <code className="rounded bg-gray-100 px-1 font-mono text-[11px] text-gray-700">{FIRST_NAME_TOKEN}</code> where
                the person&apos;s first name should go: &ldquo;Hi {FIRST_NAME_TOKEN},&rdquo; reaches Ana as &ldquo;Hi Ana,&rdquo;.
                Leave it empty to use REASON&apos;s own message.
              </p>
              <p id={counterId} className={cn('shrink-0 text-xs', over ? 'font-semibold text-red-700' : 'text-gray-500')}>{length} / {MEET_NOTE_MAX}</p>
            </div>
            {errors.note?.message && <p id={noteErrorId} role="alert" className="mt-1 text-xs text-red-700">{errors.note.message}</p>}
            {!note.trim() && (
              <button
                type="button"
                onClick={() => setValue('note', MEET_NOTE_EXAMPLE, { shouldDirty: true, shouldValidate: true })}
                className="mt-1 inline-flex min-h-[44px] items-center text-sm font-semibold text-rsn-red hover:text-rsn-red-hover"
              >
                Start from REASON&apos;s message
              </button>
            )}
          </div>

          <div>
            <label htmlFor={formatId} className="mb-1.5 block text-sm font-medium text-gray-600">Preferred format</label>
            <select
              id={formatId}
              aria-invalid={errors.format ? true : undefined}
              aria-describedby={errors.format ? formatErrorId : undefined}
              {...register('format')}
              className={cn(FIELD, 'min-h-[44px] sm:max-w-sm', errors.format ? 'border-rsn-red' : 'border-gray-200')}
            >
              {MEETING_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            {errors.format?.message && <p id={formatErrorId} role="alert" className="mt-1 text-xs text-red-700">{errors.format.message}</p>}
          </div>

          <Button type="submit" isLoading={save.isPending} disabled={!isDirty || over} className="w-full sm:w-auto" data-testid="meet-request-save">
            {save.isPending ? 'Saving…' : 'Save meeting request'}
          </Button>
        </form>
      )}
    </Card>
  );
}
