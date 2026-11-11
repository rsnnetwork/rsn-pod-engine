// ─── One question as large tiles (Part 3 Task 10; the call link's group tiles, Part 2 Task 12) ─────────────────────
// A radio each for a one-answer question, a checkbox each where several are allowed; every tile at least 56px tall, two
// columns from 400px, one below it. Controlled (the form holds the chosen keys), so the event page's sheet, the request
// sheet and the call link's details step draw the same tiles. An optional question says "(optional)" in its legend.
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { QUESTIONS_COPY, toggleChoice } from './question-form';

interface Props {
  legend: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  multiple: boolean;
  optional?: boolean;
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string;
  testId?: string;
  /** The inputs' shared name (one radio group per question). */
  name: string;
}

export default function ChoiceTiles({ legend, options, multiple, optional = false, value, onChange, error, testId, name }: Props) {
  return (
    <fieldset data-testid={testId} className="min-w-0">
      <legend className="mb-2 text-[15px] font-bold text-[#1a1a2e] [overflow-wrap:anywhere]">
        {legend}
        {optional && <span className="ml-1.5 font-normal text-gray-500">{QUESTIONS_COPY.optional}</span>}
      </legend>
      {multiple && <p className="-mt-1 mb-2 text-[13px] text-gray-500">{QUESTIONS_COPY.chooseAll}</p>}
      <div className="grid gap-2.5 min-[400px]:grid-cols-2">
        {options.map((option) => {
          const on = value.includes(option.key);
          return (
            <label
              key={option.key}
              data-testid="choice-tile"
              className={cn(
                'flex min-h-[56px] min-w-0 cursor-pointer items-center gap-3 rounded-2xl border-2 bg-white px-4 py-3 text-[15px] font-semibold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-reason-ink/30',
                on ? 'border-reason-red bg-reason-pink' : 'border-reason-line hover:border-[#cfd2d8]',
              )}
            >
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={name}
                value={option.key}
                checked={on}
                onChange={() => onChange(toggleChoice(value, option.key, multiple))}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center border-2',
                  multiple ? 'rounded-md' : 'rounded-full',
                  on ? 'border-reason-red bg-reason-red text-white' : 'border-[#c5c8cf] bg-white',
                )}
              >
                {on && <Check className="h-4 w-4" strokeWidth={3} />}
              </span>
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          );
        })}
      </div>
      {error && <p role="alert" className="mt-1.5 text-[13px] text-red-600">{error}</p>}
    </fieldset>
  );
}
