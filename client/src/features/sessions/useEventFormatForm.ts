// client/src/features/sessions/useEventFormatForm.ts
// What Schedule an Event and Edit Event share (26 Oct 2026): one react-hook-form form checked by its Zod schema through
// the shared formResolver; the switch of event type and the question it may ask first; the notices; the summary beside
// the button; how a refusal from the server lands at its field; one submit at a time; and how a field with a problem
// is brought into view clear of a sticky bar. Both forms use it, so create and edit cannot drift apart again (the
// 25 Oct audit found them disagreeing on units, defaults and fields).
import { useId, useRef, useState } from 'react';
import { useForm, type FieldPath } from 'react-hook-form';
import type { ZodType, ZodTypeDef } from 'zod';
import type { EventFormat } from '@rsn/shared';
import { formResolver } from '@/lib/form-resolver';
import {
  SETTING_KEYS, eventProblems, problemSummary, switchFormat,
  type EventFormValues, type EventProblemCopy, type EventSettingKey,
} from './event-format-form';

interface Options {
  defaultValues: EventFormValues;
  schema: ZodType<EventFormValues, ZodTypeDef, unknown>;
  /** Settings that count as chosen from the start: on an edit, every saved one. */
  touched?: Iterable<string>;
  /** What a refusal that names no field says, for this form. */
  copy: EventProblemCopy;
  /** The fields this form draws for a type: a problem with any other is said beside the button. */
  shownKeys: (format: EventFormat) => string[];
  /** After the type changed (or the pod did, with the type kept): the create form refills an untouched title. */
  onSwitched?: (format: EventFormat) => void;
}

/** The nearest ancestor that scrolls up and down: <main>, or a sheet's body. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * Bring a field into the part of its scroller that nothing covers: above the sticky bar (which sits above the phone's
 * bottom bar), centred. The whole field (label, control, message) when it fits; when that part is shorter, as with a
 * phone keyboard open, the control and its message, the label going under the top bar. A plain scrollIntoView does
 * not know about the bar and can leave the field, or its message, under it.
 */
export function bringIntoView(field: HTMLElement, bar: HTMLElement | null): void {
  const scroller = scrollerOf(field);
  const box = field.closest<HTMLElement>('[data-field]') ?? field.parentElement ?? field;
  if (!scroller) {
    box.scrollIntoView({ block: 'center' });
    return;
  }
  const view = scroller.getBoundingClientRect();
  const top = Math.max(view.top, 0);
  const barTop = bar ? bar.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
  const bottom = Math.min(view.bottom, window.innerHeight, barTop > top ? barTop : Number.POSITIVE_INFINITY);
  const room = bottom - top;
  const whole = box.getBoundingClientRect();
  const control = field.getBoundingClientRect();
  const [from, to] = whole.height <= room ? [whole.top, whole.bottom] : [control.top, Math.max(control.bottom, whole.bottom)];
  const height = to - from;
  const wanted = height >= room ? top + 4 : top + (room - height) / 2;
  scroller.scrollBy({ top: from - wanted, behavior: 'instant' as ScrollBehavior });
}

export function useEventFormatForm({ defaultValues, schema, touched: chosenAtStart, copy, shownKeys, onSwitched }: Options) {
  // shouldFocusError off: goTo takes the member to the first problem itself, clear of the sticky bar.
  const form = useForm<EventFormValues>({ defaultValues, resolver: formResolver(schema), shouldFocusError: false });
  const { getValues, setValue, setError, clearErrors, handleSubmit, watch, formState: { errors } } = form;
  const pickerName = useId();
  const formRef = useRef<HTMLFormElement>(null);
  /** The form's sticky bar, when it has one (Schedule an Event): what a field must stay clear of. */
  const barRef = useRef<HTMLDivElement>(null);
  // The settings the organiser set: a switch of type keeps them, or asks before dropping them.
  const touched = useRef(new Set<string>(chosenAtStart ?? []));
  const formatChosen = useRef(false);
  // A ref, not isPending: a double tap lands before React draws the button as disabled.
  const sending = useRef(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [asking, setAsking] = useState<{ format: EventFormat; question: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const format = watch('format');

  /** A switch into the form: the new settings, nothing the old type's fields said, and what it changed. */
  const applySwitch = (values: EventFormValues, said: string[]) => {
    for (const key of SETTING_KEYS) setValue(key, values[key]);
    setValue('format', values.format);
    clearErrors([...SETTING_KEYS, 'format']);
    setNotices(said);
    onSwitched?.(values.format);
  };

  const chooseFormat = (next: EventFormat) => {
    if (next === getValues('format')) {
      setAsking(null);
      return;
    }
    formatChosen.current = true;
    const r = switchFormat(getValues(), next, touched.current);
    if (r.confirm) {
      setAsking({ format: next, question: r.confirm });
      return;
    }
    setAsking(null);
    applySwitch(r.values, r.notices);
  };

  const continueSwitch = () => {
    if (!asking) return;
    // From the form as it is now: anything typed while the question was showing is kept.
    const r = switchFormat(getValues(), asking.format, touched.current);
    setAsking(null);
    applySwitch(r.values, r.notices);
  };

  /** The type a pod change calls for (podChangeFormat): switched without asking, the pod's notice first. */
  const followFormat = (next: EventFormat, notice: string | null) => {
    setAsking(null);
    if (next !== getValues('format')) {
      const r = switchFormat(getValues(), next, touched.current);
      applySwitch(r.values, notice ? [notice, ...r.notices] : r.notices);
      return;
    }
    setNotices(notice ? [notice] : []);
    onSwitched?.(next);
  };

  /** Focus a field with a problem (found by its name in this form) and bring it into view once its message is drawn. */
  const goTo = (key: string) => {
    const field = formRef.current?.querySelector<HTMLElement>(key === 'format' ? `input[name="${pickerName}"]:checked` : `[name="${key}"]`);
    if (!field) return;
    field.focus({ preventScroll: true });
    // Two frames: React draws the messages and the summary that makes the bar taller, then the field is placed.
    requestAnimationFrame(() => requestAnimationFrame(() => bringIntoView(field, barRef.current)));
  };

  /** The form's submit: one request at a time; when the form refuses, its first problem is brought into view. */
  const onSubmit = (send: (values: EventFormValues) => void) => handleSubmit((values) => {
    if (sending.current) return;
    sending.current = true;
    setFormError(null);
    send(values);
  }, (invalid) => {
    const first = problemSummary(Object.keys(invalid), getValues('format'))?.items[0];
    if (first) goTo(first.key);
  });

  const settled = () => { sending.current = false; };

  /** A refusal from the server (either shape) at the fields it names; anything else beside the button. */
  const refused = (err: unknown) => {
    const current = getValues('format');
    const { fields, form: message } = eventProblems(err, current, copy);
    const shown = shownKeys(current);
    const elsewhere: string[] = [];
    for (const [key, words] of Object.entries(fields)) {
      if (shown.includes(key)) setError(key as FieldPath<EventFormValues>, { type: 'server', message: words });
      else elsewhere.push(words);
    }
    setFormError([message, ...elsewhere].filter(Boolean).join(' ') || null);
    const first = problemSummary(Object.keys(fields).filter((key) => shown.includes(key)), current)?.items[0];
    if (first) goTo(first.key);
  };

  /** EventTypePicker's props: the types to offer, and a line under the label when there is something to say. */
  const picker = (formats: EventFormat[], hint?: string) => ({
    name: pickerName,
    formats,
    value: format,
    onChoose: chooseFormat,
    error: errors.format?.message,
    notices,
    confirm: asking ? { question: asking.question, onContinue: continueSwitch, onCancel: () => setAsking(null) } : null,
    hint,
  });

  const shown = shownKeys(format);
  return {
    form,
    format,
    formRef,
    barRef,
    formatChosen,
    formError,
    summary: problemSummary(Object.keys(errors).filter((key) => shown.includes(key)), format),
    picker,
    touch: (key: EventSettingKey) => { touched.current.add(key); },
    followFormat,
    goTo,
    onSubmit,
    settled,
    refused,
  };
}
