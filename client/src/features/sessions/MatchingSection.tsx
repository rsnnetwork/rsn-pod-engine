// client/src/features/sessions/MatchingSection.tsx
// One Matching section on every event type (30 Oct 2026, L19; audit 04 §6.3–6.4). "Matching rules should be available
// when creating an event": the rule sat inside the rounds timing card, so on a Video meeting (a Reason pod's default) no
// matching showed at all and nothing said why. Now:
//   - Speed networking: "Who should meet whom", REASON's presets as one-line cards (soft preferences, so the copy says
//     "first"; admins also get "Other templates…"), then the rule, four options including a cooldown with its months.
//   - Any other type: one line saying it pairs nobody, and a button that switches to Speed networking through the type
//     picker's own confirm ("Switching … removes the … settings").
import { useId } from 'react';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { Shuffle } from 'lucide-react';
import { formatRule, liveKindOf } from '@rsn/shared';
import type { EventFormat, MatchingPreset } from '@rsn/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { isPresetId, type EventFormValues, type EventSettingKey } from './event-format-form';

export type MatchingPolicyChoice = 'platform_wide' | 'within_event' | 'none' | 'cooldown';

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
    description: 'People can be matched again, even if they met before. Useful for smaller groups, curated events, or when repeated conversations are valuable.',
    hint: 'Best for small groups or repeat-attendance pods.',
  },
  {
    value: 'cooldown',
    label: 'Not again for a while',
    description: "Two people who have met won't be paired again until the months below have passed. After that they can meet again.",
    hint: 'Best for pods that meet often.',
  },
];

/** The one line any type that does not pair people shows (verbatim, 30 Oct brief). */
export const NO_PAIRING_LINE = "Video meetings don't pair people. Choose Speed networking to match people one to one.";

export interface TemplateOption { id: string; name: string; isDefault?: boolean; isPreset?: boolean }

const SECTION_HEAD = 'flex items-center gap-2 text-base font-semibold text-gray-800';
const CARD = 'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors';
const card = (checked: boolean) => cn(CARD, checked ? 'border-rsn-red bg-rsn-red/5 ring-1 ring-rsn-red' : 'border-gray-200 bg-gray-50 hover:border-gray-300');
const RADIO = 'mt-0.5 h-4 w-4 shrink-0 accent-[#1a1a2e] scroll-mt-24 scroll-mb-44';
const CONTROL = 'w-full min-h-[44px] rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] scroll-mt-24 scroll-mb-44';
const ERROR_LINE = 'text-xs text-red-500 mt-1';

export interface MatchingSectionProps {
  format: EventFormat;
  register: UseFormRegister<EventFormValues>;
  errors: FieldErrors<EventFormValues>;
  /** The form's current choices. */
  templateId: string;
  policy: string;
  onTemplate: (id: string) => void;
  onTouched: (key: EventSettingKey) => void;
  /** REASON's presets (GET /sessions/matching-presets). */
  presets: { data?: MatchingPreset[]; isLoading: boolean; isError: boolean; retry: () => void };
  isAdmin: boolean;
  /** Every template, for an admin's "Other templates…". */
  templates?: TemplateOption[];
  templatesLoading?: boolean;
  /** The types the event may switch to; Speed networking's button shows only when it is one. */
  offered: EventFormat[];
  /** Switches the type through the picker (and its question, when settings would be dropped). */
  onChooseFormat: (format: EventFormat) => void;
}

export default function MatchingSection(props: MatchingSectionProps) {
  const headId = useId();
  const { format, offered, onChooseFormat } = props;
  if (liveKindOf(format) !== 'rounds') {
    return (
      <section aria-labelledby={headId} data-testid="matching-section" className="grid gap-3">
        <h2 id={headId} className={SECTION_HEAD}><Shuffle className="h-5 w-5 text-rsn-red" /> Matching</h2>
        <p className="text-sm text-gray-600">{NO_PAIRING_LINE}</p>
        {offered.includes('speed_networking') && (
          <div>
            <Button type="button" variant="outline" onClick={() => onChooseFormat('speed_networking')}>
              Choose {formatRule('speed_networking').label}
            </Button>
          </div>
        )}
      </section>
    );
  }
  return (
    <section aria-labelledby={headId} data-testid="matching-section" className="grid gap-5">
      <h2 id={headId} className={SECTION_HEAD}><Shuffle className="h-5 w-5 text-rsn-red" /> Matching</h2>
      <WhoMeetsWhom {...props} />
      <MatchingRule {...props} />
    </section>
  );
}

function WhoMeetsWhom({ templateId, onTemplate, onTouched, presets, isAdmin, templates, templatesLoading, errors }: MatchingSectionProps) {
  const otherId = useId();
  const choose = (id: string) => {
    onTemplate(id);
    onTouched('matchingTemplateId');
  };
  const others = (templates ?? []).filter((t) => !t.isPreset && !isPresetId(t.id));
  // A template that is no preset: an admin's pick (or one stored before presets). Shown as itself, never lost.
  const onOther = !!templateId && !isPresetId(templateId);
  const error = errors.matchingTemplateId?.message;

  return (
    <fieldset data-field className="min-w-0">
      <legend className="mb-1 block text-sm font-medium text-gray-600">Who should meet whom</legend>
      <p className="mb-3 text-xs text-gray-500">REASON pairs these people first when it can. Everyone still meets someone.</p>
      {presets.isLoading ? (
        // Shaped like the loaded choices (four presets, each a name over a line, and an admin's "Other templates"), so
        // nothing below moves when they land: Safari keeps no scroll anchor, and a field scrolled to would slide (X4).
        <div aria-busy="true" aria-label="Loading the matching choices" className="grid gap-2" data-testid="matching-presets-loading">
          {Array.from({ length: isAdmin ? 5 : 4 }, (_, i) => (
            <div key={i} className={card(false)}>
              <span className={cn(RADIO, 'rounded-full bg-gray-200')} />
              <span className="min-w-0 flex-1">
                <span className="block h-5 w-40 max-w-full animate-pulse rounded bg-gray-200" />
                <span className="mt-0.5 block h-4 w-64 max-w-full animate-pulse rounded bg-gray-100" />
                {/* Below 400px most presets' lines wrap once. */}
                {i < 3 && <span className="block h-4 w-40 max-w-full animate-pulse rounded bg-gray-100 min-[400px]:hidden" />}
              </span>
            </div>
          ))}
        </div>
      ) : presets.isError ? (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          We couldn&apos;t load the matching choices.
          <button type="button" onClick={presets.retry} className="ml-2 min-h-[44px] font-semibold underline">Try again</button>
        </div>
      ) : (presets.data ?? []).length === 0 ? (
        <p className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          No matching choices yet. The event pairs people on REASON&apos;s balanced defaults.
        </p>
      ) : (
        <div className="grid gap-2" data-testid="matching-presets">
          {(presets.data ?? []).map((p) => (
            <label key={p.id} className={card(templateId === p.id)}>
              <input type="radio" name="matchingTemplateId" value={p.id} checked={templateId === p.id} onChange={() => choose(p.id)} className={RADIO} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[#1a1a2e]">{p.name}</span>
                {p.description && <span className="mt-0.5 block text-xs text-gray-600">{p.description}</span>}
              </span>
            </label>
          ))}
          {isAdmin && (
            <label className={card(onOther)}>
              <input
                type="radio" name="matchingTemplateId" value="other" checked={onOther}
                onChange={() => { const first = others[0]?.id; if (first) choose(first); }}
                disabled={!onOther && others.length === 0}
                className={RADIO}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[#1a1a2e]">Other templates…</span>
                <span className="mt-0.5 block text-xs text-gray-600">
                  {templatesLoading ? 'Loading templates…' : others.length === 0 && !onOther ? 'No other templates yet (admins only).' : 'A template from the admin page (admins only).'}
                </span>
              </span>
            </label>
          )}
          {isAdmin && onOther && (
            <div>
              <label htmlFor={otherId} className="sr-only">Other template</label>
              <select id={otherId} value={templateId} onChange={(e) => choose(e.target.value)} className={CONTROL}>
                {!others.some((t) => t.id === templateId) && <option value={templateId}>Current template</option>}
                {others.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
      {error && <p className={ERROR_LINE}>{error}</p>}
    </fieldset>
  );
}

function MatchingRule({ format, register, errors, policy, onTouched }: MatchingSectionProps) {
  const monthsId = useId();
  const fields = formatRule(format).fields;
  if (!fields.matchingPolicy) return null;
  const months = fields.cooldownMonths;
  const monthsError = errors.cooldownMonths?.message;
  return (
    <fieldset data-field className="min-w-0">
      <legend className="mb-1 block text-sm font-medium text-gray-600">{fields.matchingPolicy.label}</legend>
      <p className="mb-3 text-xs text-gray-500">Control whether people who&apos;ve met before can be paired again.</p>
      <div className="space-y-2">
        {MATCHING_POLICIES.map((p) => (
          <div key={p.value}>
            <label className={card(policy === p.value)}>
              <input
                type="radio"
                value={p.value}
                className={RADIO}
                {...register('matchingPolicy', { onChange: () => onTouched('matchingPolicy') })}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[#1a1a2e]">{p.label}</span>
                <span className="mt-0.5 block text-xs text-gray-600">{p.description}</span>
                <span className="mt-1 block text-xs italic text-gray-400">{p.hint}</span>
              </span>
            </label>
            {p.value === 'cooldown' && policy === 'cooldown' && months && (
              <div data-field className="mt-2 pl-7">
                <label htmlFor={monthsId} className="block text-sm font-medium text-gray-600 mb-1.5">{months.label}</label>
                <input
                  id={monthsId} type="number" inputMode="numeric" step={1} min={months.min} max={months.max}
                  className={cn(CONTROL, 'max-w-[10rem] bg-gray-50', monthsError ? 'border-red-500' : '')}
                  aria-invalid={monthsError ? true : undefined}
                  aria-describedby={`${monthsId}-hint`}
                  {...register('cooldownMonths', { valueAsNumber: true, onChange: () => onTouched('cooldownMonths') })}
                />
                <p id={`${monthsId}-hint`} className="text-xs text-gray-400 mt-1">{months.min} – {months.max} {months.unit}</p>
                {monthsError && <p className={ERROR_LINE}>{monthsError}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
      {errors.matchingPolicy?.message && <p className={ERROR_LINE}>{errors.matchingPolicy.message}</p>}
    </fieldset>
  );
}
