// client/src/features/sessions/EventFormatFields.tsx
// The event forms' type picker and each type's settings, shared by Schedule an Event and Edit Event (26 Oct 2026),
// drawn from the shared definition: round settings only for a rounds event (speed networking), a length for a
// meeting, a capacity with the type's own limits, every problem said at its field. 25 Oct walkthrough: a "Video
// meeting" showed five 8-minute rounds and ran as speed networking.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { FieldErrors, UseFormRegister, UseFormRegisterReturn } from 'react-hook-form';
import { Clock, Users } from 'lucide-react';
import { formatRule, liveKindOf } from '@rsn/shared';
import type { EventFieldRule, EventFormat } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { lengthOptions, settingProblem, type EventFormValues, type EventSettingKey } from './event-format-form';

export type MatchingPolicyChoice = 'platform_wide' | 'within_event' | 'none';

export const MATCHING_POLICIES: { value: MatchingPolicyChoice; label: string; description: string; hint: string }[] = [
  {
    value: 'platform_wide',
    label: 'Platform-wide no rematch',
    description: 'Strictest. If two people have ever met before anywhere on REASON, they will never be matched again.',
    hint: 'Best for large-scale discovery events.',
  },
  {
    value: 'within_event',
    label: 'Within this event only',
    description: "If two people already met in THIS event, they won't be re-paired in this event. They can meet again in future events.",
    hint: 'Recommended default — balanced.',
  },
  {
    value: 'none',
    label: 'No restriction',
    description: 'People can be matched again, even if they met before. Useful for smaller groups, curated sessions, or when repeated conversations are valuable.',
    hint: 'Best for small groups or repeat-attendance pods.',
  },
];

const TIMER_LABELS: Record<string, string> = {
  always_visible: 'Always visible',
  hidden: 'Hidden',
  last_10s: 'Show last 10 seconds',
  last_30s: 'Show last 30 seconds',
  last_60s: 'Show last 60 seconds',
  last_120s: 'Show last 2 minutes',
};

/** A control on the event forms: 44px tall, and scrolled clear of the sticky bar when the summary focuses it. */
export const EVENT_FIELD = 'w-full min-h-[44px] rounded-xl border bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 scroll-mt-24 scroll-mb-44';
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
    <fieldset aria-describedby={error ? errorId : undefined} className="min-w-0">
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
    <div className="min-w-0">
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

export interface TemplateOption { id: string; name: string; isDefault?: boolean }

interface FieldsProps {
  format: EventFormat;
  register: UseFormRegister<EventFormValues>;
  errors: FieldErrors<EventFormValues>;
  /** The meeting length now in the form, so a length that is no preset stays a choice. */
  durationMinutes: number;
  isAdmin: boolean;
  templates?: TemplateOption[];
  templatesLoading?: boolean;
  /**
   * Edit: the event already has a template. The API cannot clear one (an empty id is never sent), so "Default" is
   * not offered then: choosing it would be a save that is silently discarded.
   */
  hasTemplate?: boolean;
  /** The template the form holds, so a saved one no longer listed still shows as itself. */
  templateId?: string;
  /** The organiser set this setting: a later switch of type keeps it, or asks before dropping it. */
  onTouched: (key: EventSettingKey) => void;
}

export default function EventFormatFields({
  format, register, errors, durationMinutes, isAdmin, templates, templatesLoading, hasTemplate, templateId, onTouched,
}: FieldsProps) {
  const ids = {
    timing: useId(), rounds: useId(), roundMinutes: useId(), timer: useId(), template: useId(),
    length: useId(), capacity: useId(),
  };
  const rule = formatRule(format);
  const fields = rule.fields;
  const err = (key: EventSettingKey) => errors[key]?.message;
  // Each setting is checked against the type the form holds when it is checked, in the definition's words.
  const setting = (key: EventSettingKey, extra: { valueAsNumber?: true } = {}): UseFormRegisterReturn => register(key, {
    ...extra,
    validate: (value: unknown, values: EventFormValues) => settingProblem(values.format, key, value) ?? true,
    onChange: () => onTouched(key),
  });

  return (
    <div className="grid gap-6">
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
            {fields.matchingTemplateId && isAdmin && (
              <Field id={ids.template} label={fields.matchingTemplateId.label} hint="How participants are matched (admins only)" error={err('matchingTemplateId')}>
                {/* Registered only once the templates are here: a select drawn without the saved template's option
                    would show another one while the form still holds the saved id. */}
                {templatesLoading ? (
                  <select id={ids.template} disabled className={cn(EVENT_FIELD, fieldBorder())}>
                    <option>Loading templates…</option>
                  </select>
                ) : (
                  <select
                    id={ids.template}
                    className={cn(EVENT_FIELD, fieldBorder(err('matchingTemplateId')))}
                    {...described(ids.template, true, err('matchingTemplateId'))}
                    {...setting('matchingTemplateId')}
                  >
                    {!hasTemplate && <option value="">Default (balanced)</option>}
                    {hasTemplate && templateId && !(templates ?? []).some((t) => t.id === templateId) && (
                      <option value={templateId}>Current template</option>
                    )}
                    {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>)}
                  </select>
                )}
              </Field>
            )}
          </div>
          {fields.matchingPolicy && (
            <fieldset className="min-w-0">
              <legend className="mb-1 block text-sm font-medium text-gray-600">{fields.matchingPolicy.label}</legend>
              <p className="mb-3 text-xs text-gray-500">Control whether people who&apos;ve met before can be paired again.</p>
              <div className="space-y-2">
                {MATCHING_POLICIES.map((p) => (
                  <label key={p.value} className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 transition-colors hover:border-gray-300">
                    <input
                      type="radio"
                      value={p.value}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[#1a1a2e] scroll-mt-24 scroll-mb-44"
                      {...register('matchingPolicy', {
                        validate: (value: unknown, values: EventFormValues) => settingProblem(values.format, 'matchingPolicy', value) ?? true,
                        onChange: () => onTouched('matchingPolicy'),
                      })}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-[#1a1a2e]">{p.label}</span>
                      <span className="mt-0.5 block text-xs text-gray-600">{p.description}</span>
                      <span className="mt-1 block text-xs italic text-gray-400">{p.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {err('matchingPolicy') && <p className={ERROR_LINE}>{err('matchingPolicy')}</p>}
            </fieldset>
          )}
        </section>
      ) : fields.durationMinutes ? (
        <section className="grid gap-4">
          <h2 className={SECTION_HEAD}><Clock className="h-5 w-5 text-rsn-red" /> Timing</h2>
          <Field id={ids.length} label={fields.durationMinutes.label} hint="For the invitations and calendars. The host ends the meeting." error={err('durationMinutes')}>
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
    </div>
  );
}
