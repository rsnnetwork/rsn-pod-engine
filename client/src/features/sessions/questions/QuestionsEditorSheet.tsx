// ─── The editor for one matching question (Part 3 Task 10; spec 02) ─────────────────────────────────────────────────
// A Sheet (portalled to <body>). react-hook-form, checked by Zod and the shared validateEventQuestions (the server's own
// check), each problem at its field: the question, one answer or several, 2 to 8 answers, whether people with the same
// or different answers should meet, and whether it is required. A saved question keeps its keys, so renaming an answer
// keeps the people who chose it.
import { useEffect, useId, useMemo } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Loader2, Plus, X } from 'lucide-react';
import { MAX_QUESTION_OPTIONS, MIN_QUESTION_OPTIONS, QUESTION_LIMITS, type EventMatchingQuestion, type QuestionKind, type QuestionPrefer } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { cn } from '@/lib/utils';
import { FIELD, FieldError, LABEL, PRIMARY_BUTTON, QUIET_BUTTON, fieldBorder } from '../organiser-ui';
import { messageAt } from '../groups/group-form';
import { QUESTIONS_COPY, questionFormResolver, questionFormValuesOf, questionOfForm, type QuestionFormValues } from './question-form';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The event's saved questions. */
  saved: readonly EventMatchingQuestion[];
  /** The question being edited, or null for a new one. */
  index: number | null;
  busy: boolean;
  /** Resolves when saved; rejects with the server's refusal, said beside the button. */
  onSave: (question: EventMatchingQuestion) => Promise<unknown>;
  serverError: string | null;
}

const KINDS: QuestionKind[] = ['single', 'multiple'];
const PREFERS: QuestionPrefer[] = ['same', 'different'];
const CHOICE = 'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm';

export default function QuestionsEditorSheet({ open, onClose, saved, index, busy, onSave, serverError }: Props) {
  const formId = useId();
  const promptId = useId();
  const current = index === null ? null : saved[index] ?? null;
  const resolver = useMemo(() => questionFormResolver(saved, index), [saved, index]);
  const form = useForm<QuestionFormValues>({ defaultValues: questionFormValuesOf(current), resolver });
  const options = useFieldArray({ control: form.control, name: 'options' });
  const { reset } = form;
  useEffect(() => { if (open) reset(questionFormValuesOf(current)); }, [open, index]); // eslint-disable-line react-hooks/exhaustive-deps

  const values = form.watch();
  const errors = form.formState.errors;
  const others = saved.filter((_, i) => i !== index);

  const submit = form.handleSubmit(async (v) => {
    await onSave(questionOfForm(v, others)).catch(() => undefined);
  });

  return (
    <Sheet
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={current ? QUESTIONS_COPY.editorTitleEdit : QUESTIONS_COPY.editorTitleNew}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {serverError && <p role="alert" className="mr-auto min-w-0 basis-full text-sm text-red-600 sm:basis-auto">{serverError}</p>}
          <button type="button" onClick={onClose} disabled={busy} className={QUIET_BUTTON}>Cancel</button>
          <button type="submit" form={formId} disabled={busy} data-testid="question-save" className={PRIMARY_BUTTON}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {QUESTIONS_COPY.save}
          </button>
        </div>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-5 pb-2 pt-1" data-testid="question-editor">
        <div>
          <label htmlFor={promptId} className={LABEL}>{QUESTIONS_COPY.prompt}</label>
          <input
            id={promptId}
            data-testid="question-prompt"
            maxLength={QUESTION_LIMITS.promptMaxLength}
            className={cn(FIELD, fieldBorder(messageAt(errors, 'prompt')))}
            {...form.register('prompt')}
          />
          <FieldError message={messageAt(errors, 'prompt')} />
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-gray-700">{QUESTIONS_COPY.kindLegend}</legend>
          <div className="grid gap-2 min-[400px]:grid-cols-2">
            {KINDS.map((kind) => (
              <label key={kind} className={cn(CHOICE, values.kind === kind ? 'border-rsn-red bg-rsn-red/5' : 'border-gray-200')}>
                <input type="radio" value={kind} data-testid={`question-kind-${kind}`} className="h-4 w-4 shrink-0 accent-rsn-red" {...form.register('kind')} />
                {QUESTIONS_COPY.kinds[kind]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700">{QUESTIONS_COPY.answers}</legend>
          {options.fields.map((field, i) => {
            const error = messageAt(errors, `options.${i}.label`) ?? messageAt(errors, `options.${i}.key`);
            return (
              <div key={field.id}>
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    aria-label={QUESTIONS_COPY.answerName(i + 1)}
                    data-testid="question-option"
                    maxLength={QUESTION_LIMITS.optionLabelMaxLength}
                    className={cn(FIELD, fieldBorder(error))}
                    {...form.register(`options.${i}.label`)}
                  />
                  {options.fields.length > MIN_QUESTION_OPTIONS && (
                    <button
                      type="button"
                      onClick={() => options.remove(i)}
                      aria-label={QUESTIONS_COPY.removeAnswer(values.options?.[i]?.label ?? '')}
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
          <FieldError message={messageAt(errors, 'options')} />
          {options.fields.length < MAX_QUESTION_OPTIONS && (
            <button type="button" data-testid="question-add-option" onClick={() => options.append({ key: '', label: '' })} className={QUIET_BUTTON}>
              <Plus className="h-4 w-4" aria-hidden="true" /> {QUESTIONS_COPY.addAnswer}
            </button>
          )}
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-gray-700">{QUESTIONS_COPY.preferLegend}</legend>
          <div className="grid gap-2">
            {PREFERS.map((prefer) => (
              <label key={prefer} className={cn(CHOICE, values.prefer === prefer ? 'border-rsn-red bg-rsn-red/5' : 'border-gray-200')}>
                <input type="radio" value={prefer} data-testid={`question-prefer-${prefer}`} className="h-4 w-4 shrink-0 accent-rsn-red" {...form.register('prefer')} />
                {QUESTIONS_COPY.prefers[prefer]}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-gray-700">
          <input type="checkbox" data-testid="question-required" className="h-4 w-4 shrink-0 accent-rsn-red" {...form.register('required')} />
          {QUESTIONS_COPY.required}
        </label>
      </form>
    </Sheet>
  );
}
