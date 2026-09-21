// One question, one screen (Shradha's deck: "One screen at a time. The sheep
// carries the user through it."). Every question is this component — the list
// of options, the rules, and the "Other" text box are all just configuration,
// so the five steps cannot drift apart from each other.

import type { OnboardingOption } from '@rsn/shared';
import OptionTile from './OptionTile';

interface Props {
  options: readonly OnboardingOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** One answer (radio) or several (checkbox). */
  multiple: boolean;
  max?: number;
  /** Shown under the list when they are at the limit. */
  limitHint?: string;
  /** The free-text box "Other" reveals. */
  other?: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    maxLength: number;
    error?: string | null;
  };
}

export default function QuestionStep({ options, selected, onChange, multiple, max, limitHint, other }: Props) {
  const atLimit = !!max && selected.length >= max;

  const toggle = (key: string) => {
    if (!multiple) { onChange([key]); return; }
    if (selected.includes(key)) { onChange(selected.filter(k => k !== key)); return; }
    if (atLimit) return;
    onChange([...selected, key]);
  };

  return (
    <div role={multiple ? 'group' : 'radiogroup'}>
      <div className="flex flex-col gap-2.5">
        {options.map(o => (
          <OptionTile
            key={o.key}
            label={o.label}
            selected={selected.includes(o.key)}
            multiple={multiple}
            // At the limit, the ones already chosen stay live so a member can
            // swap one for another without first working out what to untick.
            disabled={atLimit && !selected.includes(o.key)}
            onToggle={() => toggle(o.key)}
          />
        ))}
      </div>

      {atLimit && limitHint && (
        <p className="mt-3 text-center text-xs text-gray-500" role="status">{limitHint}</p>
      )}

      {other && selected.includes('other') && (
        <div className="mt-4">
          <label htmlFor="industry-other" className="mb-1.5 block text-sm font-medium text-[#1a1a2e]">
            Which industry?
          </label>
          <input
            id="industry-other"
            type="text"
            value={other.value}
            onChange={e => other.onChange(e.target.value)}
            placeholder={other.placeholder}
            maxLength={other.maxLength}
            aria-invalid={!!other.error}
            aria-describedby={other.error ? 'industry-other-error' : undefined}
            className={`h-12 w-full rounded-xl border bg-white px-3 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-rsn-red ${
              other.error ? 'border-rsn-red' : 'border-gray-200'
            }`}
          />
          {other.error && (
            <p id="industry-other-error" className="mt-1.5 text-xs text-rsn-red">{other.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
