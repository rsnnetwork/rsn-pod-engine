// ─── The groups form: a preset or your own groups, the question, who meets whom (Part 2 Task 11; spec 05, 07) ────────
// A Sheet (portalled to <body>). react-hook-form, checked by Zod and the shared validateGroupRules (the server's own
// check), problems at their fields. While the organiser edits, the capacity notice is worked out from the form as it
// stands and the people already in each group, so "3 founders wait" shows before anything is saved. Saving a set of
// groups that leaves out a group with people in it asks first.
import { useEffect, useId, useMemo } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Loader2, Plus, X } from 'lucide-react';
import { GROUP_LIMITS, type EventGroupRules } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { useConfirm } from '@/hooks/useConfirm';
import { cn } from '@/lib/utils';
import { FIELD, FieldError, LABEL, PRIMARY_BUTTON, QUIET_BUTTON, fieldBorder } from '../organiser-ui';
import {
  GROUPS_COPY, PRESET_OPTIONS, droppedGroupsWithPeople, formValuesOf, groupFormResolver, keyedGroups, messageAt,
  presetValues, rulesOfForm, type GroupFormValues, type PresetChoice,
} from './group-form';
import RoundRulesEditor from './RoundRulesEditor';
import CapacityNotice from './CapacityNotice';

interface Props {
  open: boolean;
  onClose: () => void;
  saved: EventGroupRules | null | undefined;
  counts: Record<string, number>;
  ungrouped: number;
  numberOfRounds: number;
  busy: boolean;
  /** Resolves when saved; rejects with the server's refusal, said beside the button. */
  onSave: (rules: EventGroupRules) => Promise<unknown>;
  serverError: string | null;
}

export default function GroupsEditorSheet({ open, onClose, saved, counts, ungrouped, numberOfRounds, busy, onSave, serverError }: Props) {
  const formId = useId();
  const questionId = useId();
  const { ask, confirmDialog } = useConfirm();
  const resolver = useMemo(() => groupFormResolver(numberOfRounds), [numberOfRounds]);
  const form = useForm<GroupFormValues>({ defaultValues: formValuesOf(saved, numberOfRounds), resolver });
  const groups = useFieldArray({ control: form.control, name: 'groups' });
  const { reset } = form;
  useEffect(() => { if (open) reset(formValuesOf(saved, numberOfRounds)); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const values = form.watch();
  const keyed = keyedGroups(values.groups ?? []);
  const draft = rulesOfForm(values);
  const errors = form.formState.errors;
  const isCustom = values.preset === 'custom';

  const choosePreset = (id: PresetChoice) => {
    const next = presetValues(id, numberOfRounds);
    // The organiser's rules and fallback stay; the groups and the question come from the preset.
    reset({ ...next, rounds: form.getValues('rounds'), fallback: form.getValues('fallback') }, { keepDefaultValues: true });
  };

  const submit = form.handleSubmit(async (v) => {
    const rules = rulesOfForm(v);
    const dropped = droppedGroupsWithPeople(saved, rules, counts);
    if (dropped.length > 0 && !(await ask({
      title: GROUPS_COPY.dropsPeopleTitle, body: `${dropped.join(', ')}: ${GROUPS_COPY.dropsPeopleBody}`, confirmLabel: GROUPS_COPY.dropsPeopleConfirm, tone: 'danger',
    }))) return;
    await onSave(rules).catch(() => undefined);
  });

  return (
    <Sheet
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={GROUPS_COPY.title}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {serverError && <p role="alert" className="mr-auto min-w-0 basis-full text-sm text-red-600 sm:basis-auto">{serverError}</p>}
          <button type="button" onClick={onClose} disabled={busy} className={QUIET_BUTTON}>Cancel</button>
          <button type="submit" form={formId} disabled={busy} data-testid="groups-save" className={PRIMARY_BUTTON}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {GROUPS_COPY.save}
          </button>
        </div>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-5 pb-2 pt-1">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-gray-700">{GROUPS_COPY.presetLegend}</legend>
          <div className="flex flex-wrap gap-2">
            {PRESET_OPTIONS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={values.preset === p.id}
                data-testid={`group-preset-${p.id}`}
                onClick={() => choosePreset(p.id)}
                className={cn(
                  'inline-flex min-h-[44px] items-center rounded-full border px-4 text-sm font-medium',
                  values.preset === p.id ? 'border-rsn-red bg-rsn-red/5 text-[#1a1a2e]' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700">{GROUPS_COPY.groupsLegend}</legend>
          {groups.fields.map((field, i) => {
            const error = messageAt(errors, `groups.${i}.label`) ?? messageAt(errors, `groups.${i}.key`);
            return (
              <div key={field.id}>
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    aria-label={GROUPS_COPY.groupName(i + 1)}
                    data-testid="group-label"
                    maxLength={GROUP_LIMITS.labelMaxLength}
                    className={cn(FIELD, fieldBorder(error))}
                    {...form.register(`groups.${i}.label`)}
                  />
                  {isCustom && groups.fields.length > 1 && (
                    <button
                      type="button"
                      onClick={() => groups.remove(i)}
                      aria-label={GROUPS_COPY.removeGroup(values.groups?.[i]?.label ?? '')}
                      className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
                <FieldError message={error} />
              </div>
            );
          })}
          <FieldError message={messageAt(errors, 'groups')} />
          {isCustom && groups.fields.length < GROUP_LIMITS.maxGroups && (
            <button type="button" onClick={() => groups.append({ key: '', label: '' })} className={QUIET_BUTTON}>
              <Plus className="h-4 w-4" aria-hidden="true" /> {GROUPS_COPY.addGroup}
            </button>
          )}
        </fieldset>

        <div>
          <label htmlFor={questionId} className={LABEL}>{GROUPS_COPY.question}</label>
          <input id={questionId} maxLength={GROUP_LIMITS.questionMaxLength} className={cn(FIELD, fieldBorder(messageAt(errors, 'question')))} {...form.register('question')} />
          <FieldError message={messageAt(errors, 'question')} />
        </div>

        <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-gray-700">
          <input type="checkbox" className="h-4 w-4 shrink-0 accent-rsn-red" {...form.register('allowMultiple')} />
          {GROUPS_COPY.allowMultiple}
        </label>

        <RoundRulesEditor form={form} groups={keyed} numberOfRounds={numberOfRounds} />

        <CapacityNotice rules={draft} counts={counts} ungrouped={ungrouped} numberOfRounds={numberOfRounds} />
      </form>
      {confirmDialog}
    </Sheet>
  );
}
