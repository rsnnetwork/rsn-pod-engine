// ─── "Who can join", as a field of a circle form (Ben field test, 13 Nov 2026) ─────────────────────────────────────
// Open, Closed or Invitation only, in the words of the "Who can join" sheet (each label in bold, then its sentence).
// The new-circle form, the ask for a new circle and the edit form all use it, so the three read alike.
import type { UseFormRegisterReturn } from 'react-hook-form';
import type { CircleJoinPolicy } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { POLICY_COPY, POLICY_LABEL, POLICY_ORDER, WHO_CAN_JOIN } from './circle-logic';

interface Props {
  field: UseFormRegisterReturn;
  choice: CircleJoinPolicy;
  /** data-testid of the fieldset; each choice is `<testId>-<policy>`. */
  testId: string;
  /** The sentence under the legend, when the form needs one. */
  hint?: string;
}

export default function CirclePolicyField({ field, choice, testId, hint }: Props) {
  return (
    <fieldset className="grid gap-2" data-testid={testId}>
      <legend className="mb-1.5 text-sm font-medium text-gray-600">{WHO_CAN_JOIN}</legend>
      {hint && <p className="-mt-1 mb-1 text-[13px] text-reason-muted">{hint}</p>}
      {POLICY_ORDER.map((policy) => (
        <label
          key={policy}
          className={cn(
            'flex min-h-[56px] cursor-pointer items-start gap-3 rounded-2xl border p-3.5',
            choice === policy ? 'border-reason-red bg-reason-pink' : 'border-reason-line bg-white',
          )}
        >
          <input
            type="radio"
            value={policy}
            data-testid={`${testId}-${policy}`}
            className="mt-0.5 h-5 w-5 shrink-0 accent-reason-red"
            {...field}
          />
          <span className="min-w-0 text-[14px] text-reason-ink">
            <b>{POLICY_LABEL[policy]}:</b>{POLICY_COPY[policy].slice(POLICY_LABEL[policy].length + 1)}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
