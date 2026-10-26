// client/src/features/sessions/EditEventModal.tsx
// Edit Event (26 Oct 2026): the same type picker and settings as Schedule an Event (EventFormatFields), held the same
// way (useEventFormatForm), in a sheet whose submit stays in its sticky footer. While an event is scheduled its type
// may change to another its pod holds: a switch that would drop saved settings asks first ("Switching to Video meeting
// removes the round settings (5 rounds × 8 min). Continue?"). It replaces the old edit modal, which always showed
// round settings, kept round length in minutes where create kept seconds, and asked a templates route that does not
// exist.
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PodType } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import FormSummary from '@/components/ui/FormSummary';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { cn, localTimezoneLabel, toLocalDatetimeInput } from '@/lib/utils';
import EventFormatFields, { EVENT_FIELD, EVENT_LABEL, EventTypePicker, FIELD_SCROLL_MARGINS, fieldBorder, type TemplateOption } from './EventFormatFields';
import {
  DESCRIPTION_MAX, TITLE_MAX, editEventValues, eventChanges, eventChangesSchema, offeredFormats, shownEventKeys,
  type EventFormValues,
} from './event-format-form';
import { useEventFormatForm } from './useEventFormatForm';

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
  const descriptionId = useId();
  // LOCAL time for the datetime-local field, never toISOString (UTC), which shifted the time by the viewer's offset
  // on every save (Ali, 10 Jun).
  const [start] = useState(() => editEventValues(session, session.scheduledAt ? toLocalDatetimeInput(session.scheduledAt) : ''));
  const ev = useEventFormatForm({
    defaultValues: start.values,
    schema: eventChangesSchema,
    // Every saved setting counts as chosen: a switch that would drop one asks first.
    touched: start.touched,
    copy: EDIT_COPY,
    shownKeys: (f) => shownEventKeys(f, isAdmin),
  });
  const { register, watch, formState: { errors } } = ev.form;

  const templatesQuery = useQuery({
    queryKey: ['admin-templates'],
    queryFn: () => api.get('/admin/templates').then((r) => (r.data.data ?? []) as TemplateOption[]),
    enabled: isAdmin,
  });

  const savedFormat = start.values.format;
  const formats = podType ? offeredFormats(podType, savedFormat) : [savedFormat];

  const save = useMutation({
    networkMode: 'always',
    mutationFn: (values: EventFormValues) => api.put(`/sessions/${session.id}`, eventChanges(values, { isAdmin })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', session.id] });
      addToast('Event updated', 'success');
      onClose();
    },
    onError: ev.refused,
    onSettled: ev.settled,
  });
  const submit = ev.onSubmit((values) => save.mutate(values));
  const close = () => { if (!save.isPending) onClose(); };

  return (
    <Sheet
      open
      onClose={close}
      title="Edit Event"
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <FormSummary className="basis-full sm:basis-auto sm:flex-1" summary={ev.summary} message={ev.formError} onGoTo={ev.goTo} />
          <Button type="button" variant="ghost" onClick={close} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form={formId} isLoading={save.isPending}>Save</Button>
        </div>
      )}
    >
      <form ref={ev.formRef} id={formId} onSubmit={submit} noValidate className="grid gap-5 pb-2 pt-3">
        <EventTypePicker {...ev.picker(formats)} />

        <Input label="Title" maxLength={TITLE_MAX} error={errors.title?.message} className={FIELD_SCROLL_MARGINS} {...register('title')} />

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
          <Input label="Date and time" type="datetime-local" error={errors.scheduledAt?.message} className={FIELD_SCROLL_MARGINS} {...register('scheduledAt')} />
          <p className="text-xs text-gray-400 mt-1">Shown in your local time — {localTimezoneLabel()}.</p>
        </div>

        <EventFormatFields
          format={ev.format}
          register={register}
          errors={errors}
          durationMinutes={watch('durationMinutes')}
          isAdmin={isAdmin}
          templates={templatesQuery.data}
          templatesLoading={isAdmin && templatesQuery.isLoading}
          hasTemplate={!!session.config?.matchingTemplateId}
          templateId={watch('matchingTemplateId')}
          onTouched={ev.touch}
        />
      </form>
    </Sheet>
  );
}
