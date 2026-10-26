// ─── The Schedule Event form's format-following state (26 Oct 2026) ──────────────────────────────
//
// Which format the form is on, what follows it, and what the organiser has taken over. The rules themselves are the pure
// functions in event-form.ts; this keeps the state they need and applies them to the form's fields when the format or
// the pod changes.
//
//   - The format follows the pod until the organiser picks one the pod's type holds.
//   - The capacity of a meeting is not the capacity of a speed-networking night: it follows the format until the
//     organiser types one; one they typed that the new format does not allow is replaced, and they are told at Capacity.
//   - The title starts as "Video meeting · <pod>" and follows the format and the pod until the organiser writes one.
//   - While a pod is chosen but its type is not known yet (its list is still arriving), nothing follows: a format that
//     is not known is not guessed, so the form never shows speed networking's settings and then swaps them away.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseFormGetValues, UseFormSetValue } from 'react-hook-form';
import { applyFormatChange, defaultTitle } from '@rsn/shared';
import type { EventFormat, PodType } from '@rsn/shared';
import { formatFor, offeredFor, switchNotice } from './event-form';
import type { SessionForm } from './event-form';

interface Options {
  /** The type of the pod chosen, once it is known. */
  podType: PodType | undefined;
  podName: string;
  /** A pod is chosen and its type is not known yet. */
  pending: boolean;
  getValues: UseFormGetValues<SessionForm>;
  setValue: UseFormSetValue<SessionForm>;
}

export function useEventFormat({ podType, podName, pending, getValues, setValue }: Options) {
  // What the organiser picked, if anything.
  const [picked, setPicked] = useState<EventFormat | null>(null);
  const format = formatFor(picked, podType);
  const offered = offeredFor(podType);

  // The settings the organiser has typed in, which stay theirs.
  const touched = useRef(new Set<string>());
  const lastFormat = useRef<EventFormat>(format);
  const [capacityNotices, setCapacityNotices] = useState<string[]>([]);

  useEffect(() => {
    if (pending) return;
    const next = applyFormatChange({ format: lastFormat.current, maxParticipants: getValues('maxParticipants') }, format, touched.current);
    lastFormat.current = format;
    setValue('maxParticipants', next.values.maxParticipants);
    setCapacityNotices(next.notices);
  }, [format, pending, getValues, setValue]);

  useEffect(() => {
    if (pending) return;
    if (!touched.current.has('title')) setValue('title', defaultTitle(format, podName));
  }, [format, podName, pending, setValue]);

  /** The organiser has typed in this field: it is theirs now. A note about a capacity they have just changed is done with. */
  const touch = useCallback((field: 'title' | 'maxParticipants') => {
    touched.current.add(field);
    if (field === 'maxParticipants') setCapacityNotices([]);
  }, []);

  return { format, offered, pick: setPicked, touch, capacityNotices, switched: switchNotice(picked, podType, format) };
}
