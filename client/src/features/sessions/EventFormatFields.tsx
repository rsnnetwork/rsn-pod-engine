// client/src/features/sessions/EventFormatFields.tsx
// The event forms' type picker and each type's settings, shared by Schedule an Event and Edit Event (26 Oct 2026),
// drawn from the shared definition: round settings only for a rounds event (speed networking), a length for a
// meeting, a capacity with the type's own limits, every problem said at its field. 25 Oct walkthrough: a "Video
// meeting" showed five 8-minute rounds and ran as speed networking. 30 Oct 2026: an in-person event has a "Where"
// field and a length up to eight hours, and every type has its own Matching section (MatchingSection.tsx).
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { FieldErrors, UseFormRegister, UseFormRegisterReturn } from 'react-hook-form';
import { Clock, MapPin, Users } from 'lucide-react';
import { formatRule, liveKindOf } from '@rsn/shared';
import type { EventFieldRule, EventFormat } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { lengthOptions, type EventFormValues, type EventSettingKey } from './event-format-form';
import MatchingSection, { type MatchingSectionProps } from './MatchingSection';

export { MATCHING_POLICIES, type MatchingPolicyChoice, type TemplateOption } from './MatchingSection';

const TIMER_LABELS: Record<string, string> = {
  always_visible: 'Always visible',
  hidden: 'Hidden',
  last_10s: 'Show last 10 seconds',
  last_30s: 'Show last 30 seconds',
  last_60s: 'Show last 60 seconds',
  last_120s: 'Show last 2 minutes',
};

/** Room above and below a control when the browser scrolls it into view (Tab, focus): clear of the top bar and the sticky bar. */
export const FIELD_SCROLL_MARGINS = 'scroll-mt-24 scroll-mb-44';
/** A control on the event forms: 44px tall, with the scroll margins above. */
export const EVENT_FIELD = `w-full min-h-[44px] rounded-xl border bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 ${FIELD_SCROLL_MARGINS}`;
export const EVENT_LABEL = 'block text-sm font-medium text-gray-600 mb-1.5';
export const fieldBorder = (error?: string) => (error ? 'border-red-500' : 'border-gray-200');
const ERROR_LINE = 'text-xs text-red-500 mt-1';
const HINT_LINE = 'text-xs text-gray-400 mt-1';
const NOTE = 'mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800';
const SECTION_HEAD = 'flex items-center gap-2 text-base font-semibold text-gray-800';

/** "1 – 20", "2 – 100 people": a field's limits, from the definition. */
const rangeHint = (field: EventFieldRule) => `${field.min} – ${field.max}${field.unit ? ` ${field.unit}` : ''}`;

// ---- the type picker ----------------------------------------------------------------------------

interface PickerProps {
  /** The radio group's name, so the summary can focus the chosen card. */
  name: string;
  formats: EventFormat[];
  value: EventFormat;
  onChoose: (format: EventFormat) => void;
  error?: string;
  /** What the last switch changed (a capacity the new type cannot hold). */
  notices: string[];
  /** A switch that would drop settings the organiser chose waits for this answer. */
  confirm: { question: string; onContinue: () => void; onCancel: () => void } | null;
  hint?: string;
}

export function EventTypePicker({ name, formats, value, onChoose, error, notices, confirm, hint }: PickerProps) {
  const errorId = useId();
  const keepButton = useRef<HTMLButtonElement>(null);
  const questionPanel = useRef<HTMLDivElement>(null);
  const question = confirm?.question;
  // The question appears under the cards: it is brought to the middle of the window (clear of a sticky bar, which a
  // plain focus does not know about) and focus moves to it, so a keyboard or screen reader meets it at once.
  useEffect(() => {
    if (!question) return;
    keepButton.current?.focus({ preventScroll: true });
    questionPanel.current?.scrollIntoView({ block: 'center' });
  }, [question]);

  return (
    <fieldset data-field aria-describedby={error ? errorId : undefined} className="min-w-0">
      <legend className={EVENT_LABEL}>Event type</legend>
      {hint && <p className="mb-2 text-xs text-gray-500">{hint}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {formats.map((f) => {
          const rule = formatRule(f);
          const checked = f === value;
          return (
            <label
              key={f}
              className={cn(
                'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                checked ? 'border-rsn-red bg-rsn-red/5 ring-1 ring-rsn-red' : 'border-gray-200 bg-gray-50 hover:border-gray-300',
              )}
            >
              <input
                type="radio"
                name={name}
                value={f}
                checked={checked}
                onChange={() => onChoose(f)}
                className="mt-1 h-4 w-4 shrink-0 accent-[#1a1a2e] scroll-mt-24 scroll-mb-44"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[#1a1a2e]">{rule.label}</span>
                <span className="mt-0.5 block text-xs text-gray-600">{rule.summary}</span>
              </span>
            </label>
          );
        })}
      </div>
      {error && <p id={errorId} className={ERROR_LINE}>{error}</p>}
      <div aria-live="polite">
        {notices.map((notice) => <p key={notice} className={NOTE}>{notice}</p>)}
      </div>
      {confirm && (
        <div ref={questionPanel} role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">{confirm.question}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirm.onContinue}
              className="min-h-[44px] rounded-xl bg-[#1a1a2e] px-4 text-sm font-semibold text-white hover:bg-[#2a2a44]"
            >
              Continue
            </button>
            <button
              ref={keepButton}
              type="button"
              onClick={confirm.onCancel}
              className="min-h-[44px] rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

// ---- one type's settings -----------------------------------------------------------------------

interface FieldFrameProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  /** The section's heading already says it: the label is kept for screen readers only. */
  labelHidden?: boolean;
  children: ReactNode;
}

function Field({ id, label, hint, error, labelHidden, children }: FieldFrameProps) {
  return (
    <div data-field className="min-w-0">
      <label htmlFor={id} className={labelHidden ? 'sr-only' : EVENT_LABEL}>{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className={HINT_LINE}>{hint}</p>}
      {error && <p id={`${id}-error`} className={ERROR_LINE}>{error}</p>}
    </div>
  );
}

/** What ties a control to its hint and its error, for a screen reader. */
const described = (id: string, hasHint: boolean, error?: string) => ({
  'aria-invalid': error ? true : undefined,
  'aria-describedby': [hasHint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined,
});

/** What the form gives the Matching section beyond the fields' own props. */
type MatchingProps = Omit<MatchingSectionProps, 'format' | 'register' | 'errors' | 'onTouched' | 'isAdmin'>;

interface FieldsProps {
  format: EventFormat;
  register: UseFormRegister<EventFormValues>;
  errors: FieldErrors<EventFormValues>;
  /** The meeting length now in the form, so a length that is no preset stays a choice. */
  durationMinutes: number;
  isAdmin: boolean;
  matching: MatchingProps;
  /** The organiser set this setting: a later switch of type keeps it, or asks before dropping it. */
  onTouched: (key: EventSettingKey) => void;
}

export default function EventFormatFields({
  format, register, errors, durationMinutes, isAdmin, matching, onTouched,
}: FieldsProps) {
  const ids = {
    timing: useId(), rounds: useId(), roundMinutes: useId(), timer: useId(), place: useId(),
    length: useId(), capacity: useId(),
  };
  const rule = formatRule(format);
  const fields = rule.fields;
  const err = (key: EventSettingKey) => errors[key]?.message;
  // The form's schema checks each setting against the type the form holds (event-format-form.ts); a setting the
  // organiser changes counts as chosen.
  const setting = (key: EventSettingKey, extra: { valueAsNumber?: true } = {}): UseFormRegisterReturn => register(key, {
    ...extra,
    onChange: () => onTouched(key),
  });

  return (
    <div className="grid gap-6">
      {fields.location && (
        <section className="grid gap-4">
          <h2 className={SECTION_HEAD}><MapPin className="h-5 w-5 text-rsn-red" /> Place</h2>
          <Field id={ids.place} label={fields.location.label} hint="An address or a venue. People see it on the event page and in their invitation." error={err('location')}>
            <input
              id={ids.place} type="text" autoComplete="street-address" maxLength={fields.location.maxLength}
              placeholder="e.g. The Ivy, 1-5 West St, London"
              className={cn(EVENT_FIELD, fieldBorder(err('location')), 'placeholder:text-gray-400')}
              {...described(ids.place, true, err('location'))}
              {...setting('location')}
            />
          </Field>
        </section>
      )}
      {liveKindOf(format) === 'rounds' ? (
        <section aria-labelledby={ids.timing} className="grid gap-4">
          <h2 id={ids.timing} className={SECTION_HEAD}><Clock className="h-5 w-5 text-rsn-red" /> Timing</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {fields.numberOfRounds && (
              <Field id={ids.rounds} label={fields.numberOfRounds.label} hint={rangeHint(fields.numberOfRounds)} error={err('numberOfRounds')}>
                <input
                  id={ids.rounds} type="number" inputMode="numeric" step={1}
                  className={cn(EVENT_FIELD, fieldBorder(err('numberOfRounds')))}
                  {...described(ids.rounds, true, err('numberOfRounds'))}
                  {...setting('numberOfRounds', { valueAsNumber: true })}
                />
              </Field>
            )}
            {fields.roundMinutes && (
              <Field id={ids.roundMinutes} label={fields.roundMinutes.label} hint={rangeHint(fields.roundMinutes)} error={err('roundMinutes')}>
                <input
                  id={ids.roundMinutes} type="number" inputMode="decimal" step="any"
                  className={cn(EVENT_FIELD, fieldBorder(err('roundMinutes')))}
                  {...described(ids.roundMinutes, true, err('roundMinutes'))}
                  {...setting('roundMinutes', { valueAsNumber: true })}
                />
              </Field>
            )}
            {fields.timerVisibility && (
              <Field id={ids.timer} label={fields.timerVisibility.label} hint="When participants can see the countdown" error={err('timerVisibility')}>
                <select id={ids.timer} className={cn(EVENT_FIELD, fieldBorder(err('timerVisibility')))} {...described(ids.timer, true, err('timerVisibility'))} {...setting('timerVisibility')}>
                  {(fields.timerVisibility.options ?? []).map((o) => <option key={o} value={o}>{TIMER_LABELS[o] ?? o}</option>)}
                </select>
              </Field>
            )}
          </div>
        </section>
      ) : fields.durationMinutes ? (
        <section className="grid gap-4">
          <h2 className={SECTION_HEAD}><Clock className="h-5 w-5 text-rsn-red" /> Timing</h2>
          <Field
            id={ids.length}
            label={fields.durationMinutes.label}
            hint={liveKindOf(format) === 'none'
              ? 'For the invitations and calendars. The event ends itself when this time is up.'
              : 'For the invitations and calendars. The host ends the meeting.'}
            error={err('durationMinutes')}
          >
            <select
              id={ids.length}
              className={cn(EVENT_FIELD, fieldBorder(err('durationMinutes')))}
              {...described(ids.length, true, err('durationMinutes'))}
              {...setting('durationMinutes', { valueAsNumber: true })}
            >
              {lengthOptions(format, durationMinutes).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </section>
      ) : null}

      {fields.maxParticipants && (
        <section className="grid gap-4">
          <h2 className={SECTION_HEAD}><Users className="h-5 w-5 text-rsn-red" /> Capacity</h2>
          <Field id={ids.capacity} label={fields.maxParticipants.label} labelHidden hint={rangeHint(fields.maxParticipants)} error={err('maxParticipants')}>
            <input
              id={ids.capacity} type="number" inputMode="numeric" step={1}
              className={cn(EVENT_FIELD, fieldBorder(err('maxParticipants')))}
              {...described(ids.capacity, true, err('maxParticipants'))}
              {...setting('maxParticipants', { valueAsNumber: true })}
            />
          </Field>
        </section>
      )}

      <MatchingSection format={format} register={register} errors={errors} isAdmin={isAdmin} onTouched={onTouched} {...matching} />
    </div>
  );
}
