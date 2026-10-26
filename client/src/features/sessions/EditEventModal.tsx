// client/src/features/sessions/EditEventModal.tsx
// Edit Event (26 Oct 2026): the same type picker and settings as Schedule an Event (EventFormatFields), in a sheet
// whose submit stays in its sticky footer. While an event is scheduled its type may change to another its pod holds:
// a switch that would drop saved settings asks first ("Switching to Video meeting removes the round settings (5 rounds
// × 8 min). Continue?"). It replaces the old edit modal, which always showed round settings, kept round length in
// minutes where create kept seconds, and asked a templates route that does not exist.
import { useId, useRef, useState } from 'react';
import { useForm, type FieldPath } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fieldsFor, formatRule } from '@rsn/shared';
import type { EventFormat, PodType } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import FormSummary from '@/components/ui/FormSummary';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { cn, localTimezoneLabel, toLocalDatetimeInput } from '@/lib/utils';
import EventFormatFields, { EVENT_FIELD, EVENT_LABEL, EventTypePicker, fieldBorder, type TemplateOption } from './EventFormatFields';
import {
  DESCRIPTION_MAX, TITLE_MAX, editEventValues, eventChanges, eventProblems, offeredFormats, problemSummary, switchFormat,
  titleProblem, type EventFormValues, type EventSettingKey,
} from './event-format-form';

export interface EditableEvent {
  id: string;
  podId?: string | null;
  title?: string | null;
  description?: string | null;
  scheduledAt?: string | null;
  format?: unknown;
  config?: Record<string, unknown> | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  session: EditableEvent;
  /** The event's pod type: the types it may switch to. Unknown (the pod not loaded), only its own type is offered. */
  podType?: PodType | null;
  isAdmin: boolean;
}

const SETTING_KEYS: EventSettingKey[] = [
  'numberOfRounds', 'roundMinutes', 'timerVisibility', 'matchingPolicy', 'matchingTemplateId', 'maxParticipants', 'durationMinutes',
];

const EDIT_COPY = {
  fallback: 'Could not save the event just now. Try again in a moment.',
  forbidden: 'Only the host can change this event.',
  notFound: 'This event could not be found. It may have been deleted.',
  started: 'This event has started, so it can no longer be changed.',
};

export default function EditEventModal({ open, ...rest }: Props) {
  // Mounted only while open, so every opening starts from the event as it is now.
  if (!open) return null;
  return <EditEventSheet {...rest} />;
}

function EditEventSheet({ onClose, session, podType, isAdmin }: Omit<Props, 'open'>) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const formId = useId();
  const pickerName = useId();
  const descriptionId = useId();
  // LOCAL time for the datetime-local field, never toISOString (UTC), which shifted the time by the viewer's offset
  // on every save (Ali, 10 Jun).
  const [start] = useState(() => editEventValues(session, session.scheduledAt ? toLocalDatetimeInput(session.scheduledAt) : ''));
  const { register, handleSubmit, watch, setValue, getValues, setError, clearErrors, formState: { errors } } = useForm<EventFormValues>({
    defaultValues: start.values,
    shouldFocusError: false,
  });
  // Every saved setting counts as chosen: a switch that would drop one asks first.
  const touched = useRef(new Set(start.touched));
  const [notices, setNotices] = useState<string[]>([]);
  const [asking, setAsking] = useState<{ format: EventFormat; question: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const sending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const templatesQuery = useQuery({
    queryKey: ['admin-templates'],
    queryFn: () => api.get('/admin/templates').then((r) => (r.data.data ?? []) as TemplateOption[]),
    enabled: isAdmin,
  });

  const format = watch('format');
  const durationMinutes = watch('durationMinutes');
  const savedFormat = start.values.format;
  const formats = podType ? offeredFormats(podType, savedFormat) : [savedFormat];

  const shownKeys = (f: EventFormat): string[] => [
    'format', 'title', 'description', 'scheduledAt',
    ...fieldsFor(f).filter((key) => isAdmin || !formatRule(f).fields[key]?.adminOnly),
  ];

  const apply = (values: EventFormValues, said: string[]) => {
    for (const key of SETTING_KEYS) setValue(key, values[key]);
    setValue('format', values.format);
    clearErrors([...SETTING_KEYS, 'format']);
    setNotices(said);
  };

  const chooseFormat = (next: EventFormat) => {
    if (next === getValues('format')) {
      setAsking(null);
      return;
    }
    const r = switchFormat(getValues(), next, touched.current);
    if (r.confirm) {
      setAsking({ format: next, question: r.confirm });
      return;
    }
    setAsking(null);
    apply(r.values, r.notices);
  };

  const continueSwitch = () => {
    if (!asking) return;
    const r = switchFormat(getValues(), asking.format, touched.current);
    setAsking(null);
    apply(r.values, r.notices);
  };

  /**
   * Focus a field with a problem and bring it to the middle of the sheet. Found by its name in this form
   * (react-hook-form's setFocus waits a tick, so the field could not be centred after it).
   */
  const goTo = (key: string) => {
    const field = formRef.current?.querySelector<HTMLElement>(key === 'format' ? `input[name="${pickerName}"]:checked` : `[name="${key}"]`);
    field?.focus({ preventScroll: true });
    field?.scrollIntoView({ block: 'center' });
  };

  const save = useMutation({
    networkMode: 'always',
    mutationFn: (values: EventFormValues) => api.put(`/sessions/${session.id}`, eventChanges(values, { isAdmin })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', session.id] });
      addToast('Event updated', 'success');
      onClose();
    },
    onError: (err) => {
      const current = getValues('format');
      const { fields, form: message } = eventProblems(err, current, EDIT_COPY);
      const shown = shownKeys(current);
      const elsewhere: string[] = [];
      for (const [key, words] of Object.entries(fields)) {
        if (shown.includes(key)) setError(key as FieldPath<EventFormValues>, { type: 'server', message: words });
        else elsewhere.push(words);
      }
      setFormError([message, ...elsewhere].filter(Boolean).join(' ') || null);
      const first = problemSummary(Object.keys(fields).filter((key) => shown.includes(key)), current)?.items[0];
      if (first) goTo(first.key);
    },
    onSettled: () => { sending.current = false; },
  });

  const submit = handleSubmit((values) => {
    if (sending.current) return;
    sending.current = true;
    setFormError(null);
    save.mutate(values);
  }, (invalid) => {
    const first = problemSummary(Object.keys(invalid), getValues('format'))?.items[0];
    if (first) goTo(first.key);
  });

  const close = () => { if (!save.isPending) onClose(); };
  const summary = problemSummary(Object.keys(errors).filter((key) => shownKeys(format).includes(key)), format);

  return (
    <Sheet
      open
      onClose={close}
      title="Edit Event"
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <FormSummary className="basis-full sm:basis-auto sm:flex-1" summary={summary} message={formError} onGoTo={goTo} />
          <Button type="button" variant="ghost" onClick={close} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form={formId} isLoading={save.isPending}>Save</Button>
        </div>
      )}
    >
      <form ref={formRef} id={formId} onSubmit={(e) => { clearErrors('format'); return submit(e); }} noValidate className="grid gap-5 pb-2 pt-3">
        <EventTypePicker
          name={pickerName}
          formats={formats}
          value={format}
          onChoose={chooseFormat}
          error={errors.format?.message}
          notices={notices}
          confirm={asking ? { question: asking.question, onContinue: continueSwitch, onCancel: () => setAsking(null) } : null}
        />

        <Input
          label="Title"
          maxLength={TITLE_MAX}
          error={errors.title?.message}
          {...register('title', { validate: (v) => titleProblem(v) ?? true })}
        />

        <div>
          <label htmlFor={descriptionId} className={EVENT_LABEL}>Description <span className="font-normal text-gray-400">(optional)</span></label>
          <textarea
            id={descriptionId}
            rows={3}
            maxLength={DESCRIPTION_MAX}
            className={cn(EVENT_FIELD, fieldBorder(errors.description?.message), 'resize-none')}
            aria-invalid={errors.description ? true : undefined}
            {...register('description')}
          />
          {errors.description && <p className="text-xs text-red-500 mt-1">{errors.description.message}</p>}
        </div>

        <div>
          <Input label="Date and time" type="datetime-local" error={errors.scheduledAt?.message} {...register('scheduledAt')} />
          <p className="text-xs text-gray-400 mt-1">Shown in your local time — {localTimezoneLabel()}.</p>
        </div>

        <EventFormatFields
          format={format}
          register={register}
          errors={errors}
          durationMinutes={durationMinutes}
          isAdmin={isAdmin}
          templates={templatesQuery.data}
          templatesLoading={isAdmin && templatesQuery.isLoading}
          hasTemplate={!!session.config?.matchingTemplateId}
          templateId={watch('matchingTemplateId')}
          onTouched={(key) => touched.current.add(key)}
        />
      </form>
    </Sheet>
  );
}
