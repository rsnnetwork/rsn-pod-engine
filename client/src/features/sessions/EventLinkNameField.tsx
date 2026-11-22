// ─── The event link's name, on Schedule an Event and Edit Event (Stefan, 11 Nov 2026) ─────────────────────────────────
// Every event has a link people read and share: /events/<name>-<n>. The organiser chooses the name (empty: the name the
// pod's latest public event uses, else "event", or "rsn" for a platform admin), and each event under it gets the next
// number. "rsn" is RSN's own: only platform admins may choose it (controller ruling, 12 Nov 2026). A private or invitation-only
// event's link ends with a random code, so nobody finds it by trying the next number.
//
// Under the field, the link as it will look, read from the server as the organiser pauses typing
// (GET /sessions/event-link-name: the default name, the number it would most likely get, the address). The shape of the
// name is checked here at once, in the shared rule's words (the server says the same); a name the form already refuses
// asks the server nothing.
import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UseFormReturn } from 'react-hook-form';
import { Link2 } from 'lucide-react';
import {
  EVENT_LINK_NAME_MAX, eventLinkNameProblem, eventLinkNameProblemFor, normaliseEventLinkName,
  type EventLinkNameCheck, type EventVisibility,
} from '@rsn/shared';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { EVENT_FIELD, EVENT_LABEL, fieldBorder } from './EventFormatFields';
import type { EventFormValues } from './event-format-form';

export const EVENT_LINK_FIELD_COPY = {
  label: 'Event link name',
  optional: '(optional)',
  hint: 'Each event under this name gets the next number.',
  preview: 'Your event link',
  privateTail: 'A private or invitation-only event\'s link ends with a short random code, so nobody can guess it. You will see it once the event is saved.',
  checking: 'Checking the link…',
  unreadable: 'The link preview could not be read just now. You can still save.',
} as const;

/** How long the field waits after the last key before it asks the server (ms). */
const PAUSE_MS = 400;

interface Props {
  form: UseFormReturn<EventFormValues>;
  /** Creating: the pod chosen. */
  podId?: string;
  /** Editing: the event. */
  sessionId?: string;
  visibility: EventVisibility;
  circleId?: string;
  /** Spacing from the field above, where the form needs it. */
  className?: string;
  /** A platform admin may choose RSN's own name ("rsn"). */
  isAdmin: boolean;
  /** Editing: the event's own name, which is never a problem to keep. */
  currentName?: string | null;
}

/** The name the organiser typed, as the server will store it, after they pause. */
function usePausedName(typed: string): string {
  const [paused, setPaused] = useState(typed);
  useEffect(() => {
    const t = window.setTimeout(() => setPaused(typed), PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [typed]);
  return paused;
}

export default function EventLinkNameField({ form, podId, sessionId, visibility, circleId, className, isAdmin, currentName }: Props) {
  const fieldId = useId();
  const hintId = useId();
  const { register, watch, formState: { errors } } = form;
  const typed = normaliseEventLinkName(watch('linkName') ?? '');
  const paused = usePausedName(typed);
  const shapeProblem = typed && typed !== currentName ? eventLinkNameProblemFor(typed, { platform: isAdmin }) : null;
  const askable = !!(podId || sessionId) && !(paused && eventLinkNameProblem(paused));

  // The number is only likely (another event may take it first); the server decides it when the event is saved.
  // realtime: skip — the form's as-you-type check of a name, asked again on every pause in typing
  const check = useQuery<EventLinkNameCheck>({
    queryKey: ['event-link-name', sessionId ?? null, podId ?? null, paused, visibility, circleId ?? null],
    queryFn: () => api.get('/sessions/event-link-name', {
      params: {
        ...(sessionId ? { sessionId } : { podId }),
        ...(paused ? { name: paused } : {}),
        visibility,
        ...(circleId && !sessionId ? { circleId } : {}),
      },
    }).then((r) => r.data.data as EventLinkNameCheck),
    enabled: askable,
    staleTime: 30_000,
    retry: false,
  });

  const problem = errors.linkName?.message ?? shapeProblem ?? (paused === typed ? check.data?.problem ?? null : null);
  const isPrivate = check.data?.private ?? visibility === 'private';
  const preview = !problem && check.data?.preview ? check.data.preview.replace(/^https?:\/\//, '') : null;

  return (
    <div data-field="linkName" data-testid="event-link-name-field" className={className}>
      <label htmlFor={fieldId} className={EVENT_LABEL}>
        {EVENT_LINK_FIELD_COPY.label} <span className="font-normal text-gray-400">{EVENT_LINK_FIELD_COPY.optional}</span>
      </label>
      <input
        id={fieldId}
        type="text"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={EVENT_LINK_NAME_MAX + 20}
        placeholder={check.data?.defaultName ?? 'rsn'}
        aria-invalid={problem ? true : undefined}
        aria-describedby={hintId}
        data-testid="event-link-name-input"
        className={cn(EVENT_FIELD, fieldBorder(problem ?? undefined), 'placeholder:text-gray-400')}
        {...register('linkName')}
      />
      <div id={hintId} className="mt-1.5 space-y-1">
        {problem
          ? <p className="text-xs text-red-500" data-testid="event-link-name-problem">{problem}</p>
          : <p className="text-xs text-gray-500">{EVENT_LINK_FIELD_COPY.hint}</p>}
        {!problem && (podId || sessionId) && (
          <div className="flex min-w-0 items-start gap-1.5 text-xs text-gray-600" aria-live="polite">
            <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden="true" />
            {preview ? (
              <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="event-link-preview">
                {EVENT_LINK_FIELD_COPY.preview}: <span className="font-medium text-[#1a1a2e]">{preview}{isPrivate ? '-······' : ''}</span>
              </span>
            ) : (
              <span className="text-gray-400">{check.isError ? EVENT_LINK_FIELD_COPY.unreadable : EVENT_LINK_FIELD_COPY.checking}</span>
            )}
          </div>
        )}
        {!problem && isPrivate && <p className="text-xs text-gray-500" data-testid="event-link-private-note">{EVENT_LINK_FIELD_COPY.privateTail}</p>}
      </div>
    </div>
  );
}
