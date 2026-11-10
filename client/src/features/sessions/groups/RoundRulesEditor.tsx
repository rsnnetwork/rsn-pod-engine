// ─── Who meets whom, per run of rounds, and what happens when groups are uneven (Part 2 Task 11; spec 05, 07) ────────
// One row per range: From round, To round, and "Everyone can meet" / "Only different groups meet" / "Choose pairs"
// (with the pairs as 44px checkboxes). Rounds no row covers let everyone meet. The fallback is the organiser's choice
// for people a rule leaves without a partner. Part of the groups form (react-hook-form): problems show at their row.
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FIELD, FieldError, LABEL, QUIET_BUTTON, fieldBorder } from '../organiser-ui';
import { FALLBACK_OPTIONS, GROUPS_COPY, RULE_MODE_OPTIONS, messageAt, pairOptions, type GroupFormValues } from './group-form';

interface Props {
  form: UseFormReturn<GroupFormValues>;
  /** The form's groups, each with its key (new ones named from their labels). */
  groups: ReadonlyArray<{ key: string; label: string }>;
  numberOfRounds: number;
}

const CHOICE = 'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm';

export default function RoundRulesEditor({ form, groups, numberOfRounds }: Props) {
  const rules = useFieldArray({ control: form.control, name: 'rounds' });
  const errors = form.formState.errors;
  const roundNumbers = Array.from({ length: Math.max(1, numberOfRounds) }, (_, i) => i + 1);
  const pairs = pairOptions(groups.filter((g) => g.key));
  const fallback = form.watch('fallback');

  const addRule = () => {
    const covered = form.getValues('rounds').reduce((m, r) => Math.max(m, Number(r.toRound) || 0), 0);
    const from = Math.min(covered + 1, numberOfRounds);
    rules.append({ fromRound: from, toRound: numberOfRounds, mode: 'cross_group', allowedPairs: [] });
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-gray-700">{GROUPS_COPY.roundsLegend}</legend>
        <p className="text-xs text-gray-500">{GROUPS_COPY.roundsHint}</p>
        {rules.fields.map((field, i) => {
          const mode = form.watch(`rounds.${i}.mode`);
          const rowError = messageAt(errors, `rounds.${i}`);
          const modeError = messageAt(errors, `rounds.${i}.mode`);
          const pairsError = messageAt(errors, `rounds.${i}.allowedPairs`);
          const chosenPairs = form.watch(`rounds.${i}.allowedPairs`) ?? [];
          return (
            <div key={field.id} data-testid="round-rule" className="min-w-0 space-y-3 rounded-xl border border-gray-200 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
                <div className="min-w-0">
                  <label htmlFor={`rule-${field.id}-from`} className={LABEL}>{GROUPS_COPY.from}</label>
                  <select id={`rule-${field.id}-from`} data-testid="round-rule-from" className={cn(FIELD, fieldBorder(rowError))} {...form.register(`rounds.${i}.fromRound`, { valueAsNumber: true })}>
                    {roundNumbers.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="min-w-0">
                  <label htmlFor={`rule-${field.id}-to`} className={LABEL}>{GROUPS_COPY.to}</label>
                  <select id={`rule-${field.id}-to`} data-testid="round-rule-to" className={cn(FIELD, fieldBorder(rowError))} {...form.register(`rounds.${i}.toRound`, { valueAsNumber: true })}>
                    {roundNumbers.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <label htmlFor={`rule-${field.id}-mode`} className={LABEL}>{GROUPS_COPY.mode}</label>
                  <select id={`rule-${field.id}-mode`} data-testid="round-rule-mode" className={cn(FIELD, fieldBorder(modeError))} {...form.register(`rounds.${i}.mode`)}>
                    {RULE_MODE_OPTIONS.map((o) => <option key={o.mode} value={o.mode}>{o.label}</option>)}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => rules.remove(i)}
                  aria-label={GROUPS_COPY.removeRule}
                  className="col-span-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100 sm:col-span-1"
                >
                  <X className="h-4 w-4" aria-hidden="true" /><span className="sm:sr-only">{GROUPS_COPY.removeRule}</span>
                </button>
              </div>
              <FieldError message={rowError ?? modeError} />
              {mode === 'custom' && (
                <fieldset className="space-y-2">
                  <legend className="text-sm text-gray-700">{GROUPS_COPY.pairsLegend}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {pairs.map((p) => (
                      <label key={p.key} className={cn(CHOICE, 'border-gray-200 bg-white')}>
                        <input
                          type="checkbox"
                          checked={chosenPairs.includes(p.key)}
                          onChange={(e) => form.setValue(
                            `rounds.${i}.allowedPairs`,
                            e.target.checked ? [...chosenPairs, p.key] : chosenPairs.filter((k) => k !== p.key),
                            { shouldDirty: true, shouldValidate: form.formState.isSubmitted },
                          )}
                          className="h-4 w-4 shrink-0 accent-rsn-red"
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{p.label}</span>
                      </label>
                    ))}
                  </div>
                  <FieldError message={pairsError} />
                </fieldset>
              )}
            </div>
          );
        })}
        <button type="button" data-testid="round-rule-add" onClick={addRule} className={QUIET_BUTTON}>
          <Plus className="h-4 w-4" aria-hidden="true" /> {GROUPS_COPY.addRule}
        </button>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">{GROUPS_COPY.fallbackLegend}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {FALLBACK_OPTIONS.map((o) => (
            <label
              key={o.value}
              data-testid={`group-fallback-${o.value}`}
              className={cn(CHOICE, fallback === o.value ? 'border-rsn-red bg-rsn-red/5' : 'border-gray-200 bg-white')}
            >
              <input type="radio" value={o.value} className="h-4 w-4 shrink-0 accent-rsn-red" {...form.register('fallback')} />
              <span className="min-w-0">{o.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
