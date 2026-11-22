// ─── The answers a member gives an event: its group question and its extra matching questions (Part 3 Task 10) ──────
// One form (react-hook-form + Zod through formResolver) the event page's "Before you join" sheet, its "Your answers"
// sheet and its "Request to join" sheet render. The group tiles show only when the event asks for a group and the
// person has none yet; then each question, required ones first, optional ones marked "(optional)". The buttons live
// in the sheet's footer and name this form (`form={formId}`).
import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { EventAnswers, EventMatchingQuestion } from '@rsn/shared';
import { formResolver } from '@/lib/form-resolver';
import ChoiceTiles from './ChoiceTiles';
import { GROUPS_FIELD, answerField, answerFormDefaults, answerFormSchema, answersOfForm, type AnswerFormValues } from './question-form';

/** The group question as the event asks it (GET /sessions/:id/groups). */
export interface GroupAsk {
  question: string;
  multiple: boolean;
  options: ReadonlyArray<{ key: string; label: string }>;
}

export interface GivenAnswers { groupKeys: string[]; answers: EventAnswers }

interface Props {
  formId: string;
  group: GroupAsk | null;
  questions: readonly EventMatchingQuestion[];
  mine: EventAnswers;
  /** Send an emptied optional answer as empty (it clears it), for a person changing answers already given. */
  clearEmpty?: boolean;
  onSubmit: (given: GivenAnswers) => unknown;
}

/** Required questions first, each part in the event's order. */
function requiredFirst(questions: readonly EventMatchingQuestion[]): EventMatchingQuestion[] {
  return [...questions.filter((q) => q.required), ...questions.filter((q) => !q.required)];
}

export default function EventAnswersForm({ formId, group, questions, mine, clearEmpty = false, onSubmit }: Props) {
  const ordered = useMemo(() => requiredFirst(questions), [questions]);
  const resolver = useMemo(() => formResolver(answerFormSchema(ordered, !!group)), [ordered, group]);
  const form = useForm<AnswerFormValues>({ defaultValues: answerFormDefaults(ordered, mine), resolver });
  const { reset } = form;
  // The questions or the person's answers changed on the server while the sheet was open (the tags refetch them).
  const shape = `${ordered.map((q) => `${q.key}:${q.options.map((o) => o.key).join(',')}`).join('|')}#${JSON.stringify(mine)}`;
  useEffect(() => { reset(answerFormDefaults(ordered, mine)); }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = form.handleSubmit((values) => onSubmit({
    groupKeys: group ? values[GROUPS_FIELD] ?? [] : [],
    answers: answersOfForm(values, ordered, clearEmpty),
  }));

  return (
    <form id={formId} onSubmit={submit} noValidate className="space-y-5" data-testid="event-answers-form">
      {group && (
        <Controller
          control={form.control}
          name={GROUPS_FIELD}
          render={({ field, fieldState }) => (
            <ChoiceTiles
              legend={group.question}
              options={group.options}
              multiple={group.multiple}
              value={field.value ?? []}
              onChange={field.onChange}
              error={fieldState.error?.message}
              testId="answers-group-question"
              name={`${formId}-groups`}
            />
          )}
        />
      )}
      {ordered.map((q) => (
        <Controller
          key={q.key}
          control={form.control}
          name={answerField(q.key)}
          render={({ field, fieldState }) => (
            <ChoiceTiles
              legend={q.prompt}
              options={q.options}
              multiple={q.kind === 'multiple'}
              optional={!q.required}
              value={field.value ?? []}
              onChange={field.onChange}
              error={fieldState.error?.message}
              testId={`answers-question-${q.key}`}
              name={`${formId}-${q.key}`}
            />
          )}
        />
      ))}
    </form>
  );
}
