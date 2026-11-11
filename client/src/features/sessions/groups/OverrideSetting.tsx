// ─── "Who can override these rules": the owner's choice under Matching groups (Part 3 Task 13; Task 12's server) ─────
// Two radio tiles for the event's owner (and a super admin); a co-host or director reads the current choice and why they
// cannot change it. A choice is saved at once through the groups write (it keeps the event's groups and rules as they
// are) and the groups query refetches on session:<id>:groups, so every organiser's screen follows without a refresh.
import { useId } from 'react';
import { Loader2 } from 'lucide-react';
import { DEFAULT_GROUP_QUESTION, type EventGroupRules, type GroupOverrideBy } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { GROUPS_COPY, OVERRIDE_OPTIONS } from './group-form';
import type { useSaveEventGroups } from './useEventGroups';

interface Props {
  current: GroupOverrideBy;
  rules: EventGroupRules | null;
  canChoose: boolean;
  save: ReturnType<typeof useSaveEventGroups>;
  onError: (err: unknown) => void;
}

/** The rules a choice is saved with: the event's own as they are, or none at all while it has no groups. */
export function rulesWithOverride(rules: EventGroupRules | null, overrideBy: GroupOverrideBy): EventGroupRules {
  if (rules) return { ...rules, overrideBy };
  return { groups: [], question: DEFAULT_GROUP_QUESTION, allowMultiple: false, fallback: 'leave_unmatched', rounds: [], overrideBy };
}

export default function OverrideSetting({ current, rules, canChoose, save, onError }: Props) {
  const name = useId();
  const shown = save.isPending && save.variables?.overrideBy ? save.variables.overrideBy : current;
  const choose = (value: GroupOverrideBy) => {
    if (value === current || save.isPending) return;
    save.mutate(rulesWithOverride(rules, value), { onError });
  };

  return (
    <fieldset data-testid="override-setting" className="mb-3 min-w-0 rounded-xl border border-gray-200 p-3">
      <legend className="px-1 text-sm font-medium text-gray-700">{GROUPS_COPY.overrideLegend}</legend>
      {canChoose ? (
        <>
          <p className="mb-2 text-xs text-gray-500">{GROUPS_COPY.overrideHint}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {OVERRIDE_OPTIONS.map((o) => (
              <label
                key={o.value}
                data-testid={`override-${o.value}`}
                className={cn(
                  'flex min-h-[44px] min-w-0 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm font-medium text-[#1a1a2e]',
                  shown === o.value ? 'border-rsn-red bg-rsn-red/5 ring-1 ring-rsn-red' : 'border-gray-200 bg-gray-50 hover:border-gray-300',
                  save.isPending && 'cursor-not-allowed opacity-70',
                )}
              >
                <input
                  type="radio" name={name} value={o.value} checked={shown === o.value} disabled={save.isPending}
                  onChange={() => choose(o.value)} className="h-4 w-4 shrink-0 accent-[#1a1a2e]"
                />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o.label}</span>
                {save.isPending && save.variables?.overrideBy === o.value && <Loader2 className="h-4 w-4 animate-spin text-gray-500" aria-hidden="true" />}
              </label>
            ))}
          </div>
        </>
      ) : (
        <div data-testid="override-readonly">
          <p className="text-sm text-[#1a1a2e]">{GROUPS_COPY.overrideNow(current)}</p>
          <p className="mt-1 text-xs text-gray-500">{GROUPS_COPY.overrideReadOnly}</p>
        </div>
      )}
    </fieldset>
  );
}
