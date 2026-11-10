// "Check" (Part 2, Task 12; spec 02 "show only those missing fields, then continue directly into the event"): only the
// fields the server flagged in `missing`. A name; the event's group question as large tiles (a radio for one group, a
// checkbox each where the event allows several), at least 56px tall; an admission code for an invitation-only event,
// under the event's own sentence. Nothing else: no profile, no interests.
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowRight, Check } from 'lucide-react';
import { CALL_DISPLAY_NAME_MAX, cleanCallDisplayName } from '@rsn/shared';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { CALL_WORDS, enterFailure, type DetailsFields, type EntryFailure } from './call-entry';

interface DetailsForm { displayName: string; groupKey: string; groupKeys: string[]; admissionCode: string }

export interface DetailsAnswer { displayName?: string; groupKeys?: string[]; admissionCode?: string }

interface Props {
  fields: DetailsFields;
  /** The event's own sentence when it does not take this person yet (an invitation-only event). */
  refusal: string | null;
  /** The organisers approve each place: the button asks instead of joining. */
  approval: boolean;
  defaults: { admissionCode: string };
  submit: (answer: DetailsAnswer) => Promise<void>;
  onClosed: (closed: NonNullable<EntryFailure['closed']>) => void;
}

export default function CallDetailsStep({ fields, refusal, approval, defaults, submit, onClosed }: Props) {
  const [failure, setFailure] = useState<EntryFailure | null>(null);
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<DetailsForm>({
    defaultValues: { displayName: '', groupKey: '', groupKeys: [], admissionCode: defaults.admissionCode },
  });
  const group = fields.group;
  const chosen = group?.multiple ? (watch('groupKeys') ?? []) : [watch('groupKey')].filter(Boolean);

  const onSubmit = handleSubmit(async (form) => {
    setFailure(null);
    const answer: DetailsAnswer = {};
    if (fields.displayName) answer.displayName = cleanCallDisplayName(form.displayName) ?? form.displayName;
    if (group) answer.groupKeys = group.multiple ? form.groupKeys : [form.groupKey];
    if (fields.admissionCode) answer.admissionCode = form.admissionCode.trim();
    try {
      await submit(answer);
    } catch (err) {
      const said = enterFailure(err);
      if (said.closed) {
        onClosed(said.closed);
        return;
      }
      setFailure(said);
    }
  });

  const fieldError = (field: EntryFailure['field']) => (failure?.field === field ? failure.message : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" data-testid="call-details-step">
      <div>
        <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em]">
          {approval ? 'Before you ask to join' : 'Almost there'}
        </h2>
        <p className="mt-1.5 text-[15px] text-reason-muted">This event needs just this from you.</p>
      </div>

      {refusal && (
        <p className="rounded-xl bg-reason-pink px-3.5 py-2.5 text-[14px] text-reason-red" data-testid="call-refusal">{refusal}</p>
      )}

      {fields.displayName && (
        <Input
          label="Your name"
          autoComplete="name"
          placeholder="How people in the event will see you"
          className="min-h-[48px] bg-white"
          maxLength={CALL_DISPLAY_NAME_MAX + 20}
          error={errors.displayName?.message ?? fieldError('displayName')}
          {...register('displayName', {
            validate: (v) => (cleanCallDisplayName(v) ? true : `Enter your name (up to ${CALL_DISPLAY_NAME_MAX} characters).`),
          })}
        />
      )}

      {group && (
        <fieldset data-testid="call-group-question">
          <legend className="mb-2 text-[15px] font-bold">{group.question}</legend>
          {group.multiple && <p className="-mt-1 mb-2 text-[13px] text-reason-muted">Choose all that apply.</p>}
          <div className="grid gap-2.5 min-[400px]:grid-cols-2">
            {group.options.map((option) => {
              const on = chosen.includes(option.key);
              return (
                <label
                  key={option.key}
                  className={cn(
                    'flex min-h-[56px] cursor-pointer items-center gap-3 rounded-2xl border-2 bg-white px-4 py-3 text-[15px] font-semibold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-reason-ink/30',
                    on ? 'border-reason-red bg-reason-pink' : 'border-reason-line hover:border-[#cfd2d8]',
                  )}
                >
                  <input
                    type={group.multiple ? 'checkbox' : 'radio'}
                    value={option.key}
                    className="sr-only"
                    {...register(group.multiple ? 'groupKeys' : 'groupKey', {
                      validate: (v) => ((Array.isArray(v) ? v.length > 0 : !!v) ? true : 'Choose your group.'),
                    })}
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center border-2',
                      group.multiple ? 'rounded-md' : 'rounded-full',
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
          {(errors.groupKey?.message || errors.groupKeys?.message) && (
            <p role="alert" className="mt-1.5 text-[13px] text-red-600">{errors.groupKey?.message ?? errors.groupKeys?.message}</p>
          )}
        </fieldset>
      )}

      {fields.admissionCode && (
        <Input
          label="Admission code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="min-h-[48px] bg-white font-mono uppercase tracking-[0.08em]"
          error={errors.admissionCode?.message ?? fieldError('admissionCode')}
          {...register('admissionCode', {
            validate: (v) => (v.trim() ? true : 'Enter your admission code.'),
            maxLength: { value: 40, message: 'That admission code is too long.' },
          })}
        />
      )}

      {failure && failure.field === null && (
        <p role="alert" className="rounded-xl bg-reason-pink px-3.5 py-2.5 text-[14px] text-reason-red">{failure.message}</p>
      )}

      <Button type="submit" size="lg" className="w-full rounded-2xl" isLoading={isSubmitting}>
        {approval ? 'Ask to join' : 'Join the event'}
        {!isSubmitting && <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />}
      </Button>
      {isSubmitting && <p role="status" className="sr-only">{CALL_WORDS.joining}</p>}
    </form>
  );
}
