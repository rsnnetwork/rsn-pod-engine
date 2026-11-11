// ─── Edit a circle's details (Shirley pilot S2, 11 Nov 2026; brief RSN 02, acceptance test 01) ─────────────────────
// Its name and description, for the people who run it; who can join (Open or Closed), for its owner only (D3), in the
// same words as the "Who can join" sheet. Only what changed is sent (PATCH /circles/:id); a name another circle here
// already has is refused by the server and said inline. Saving Open lets everyone still waiting in, and says so first.
import { useForm } from 'react-hook-form';
import type { CircleJoinPolicy } from '@rsn/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { POLICY_COPY, POLICY_LABEL, WHO_CAN_JOIN, type CircleDetail } from './circle-logic';
import { CIRCLE_DESCRIPTION_MAX, CIRCLE_NAME_MAX, CIRCLE_NAME_MIN, EDIT_DETAILS, circleEdits } from './circle-admin';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

interface Props { circle: CircleDetail; onClose: () => void }
interface Values { name: string; description: string; joinPolicy: CircleJoinPolicy }

export default function EditCircleSheet({ circle, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const mayChoosePolicy = !!circle.isOwner;
  const current: CircleJoinPolicy = circle.joinPolicy ?? 'open';
  const { register, handleSubmit, watch, setError, formState: { errors } } = useForm<Values>({
    defaultValues: { name: circle.name, description: circle.description ?? '', joinPolicy: current },
  });
  const save = useMutation({
    networkMode: 'always',
    mutationFn: (edits: ReturnType<typeof circleEdits>) => api.patch(`/circles/${circle.id}`, edits),
    onSuccess: async () => {
      await refreshCircle(qc, circle.id);
      addToast('Saved.', 'success');
      onClose();
    },
    onError: (err) => setError('root', { message: circleErrorSentence(err, 'That could not be saved. Try again.') }),
  });
  const choice = watch('joinPolicy');
  const waiting = circle.requestCount ?? 0;
  const opening = mayChoosePolicy && current === 'closed' && choice === 'open' && waiting > 0;

  const submit = handleSubmit((values) => {
    if (save.isPending) return;
    const edits = circleEdits({ name: circle.name, description: circle.description, joinPolicy: current }, values, mayChoosePolicy);
    if (Object.keys(edits).length === 0) { onClose(); return; }
    save.mutate(edits);
  });

  return (
    <Sheet
      open
      onClose={() => { if (!save.isPending) onClose(); }}
      title={EDIT_DETAILS}
      footer={(
        <>
          <Button variant="ghost" type="button" onClick={onClose} disabled={save.isPending} className="min-h-[44px]">Cancel</Button>
          <Button type="button" onClick={() => void submit()} isLoading={save.isPending} data-testid="circle-edit-save" className="min-h-[44px]">Save</Button>
        </>
      )}
    >
      <form className="mt-2 space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate data-testid="circle-edit-form">
        <Input
          label="Name"
          data-testid="circle-edit-name"
          maxLength={CIRCLE_NAME_MAX}
          error={errors.name?.message}
          {...register('name', {
            validate: (v) => {
              const n = v.trim().length;
              if (n < CIRCLE_NAME_MIN) return `Give it a name of at least ${CIRCLE_NAME_MIN} characters.`;
              if (n > CIRCLE_NAME_MAX) return `Keep the name to ${CIRCLE_NAME_MAX} characters.`;
              return true;
            },
          })}
        />
        <div>
          <label htmlFor="circle-edit-description" className="block text-sm font-medium text-gray-600 mb-1.5">Description</label>
          <textarea
            id="circle-edit-description"
            rows={4}
            maxLength={CIRCLE_DESCRIPTION_MAX}
            data-testid="circle-edit-description"
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[15px] text-gray-900 focus:border-rsn-red focus:outline-none"
            aria-invalid={!!errors.description}
            {...register('description', {
              maxLength: { value: CIRCLE_DESCRIPTION_MAX, message: `Keep the description to ${CIRCLE_DESCRIPTION_MAX} characters.` },
            })}
          />
          {errors.description && <p role="alert" className="mt-1 text-[13px] text-reason-red">{errors.description.message}</p>}
        </div>
        {mayChoosePolicy && (
          <fieldset className="grid gap-2" data-testid="circle-edit-policy">
            <legend className="mb-1.5 text-sm font-medium text-gray-600">{WHO_CAN_JOIN}</legend>
            {(['open', 'closed'] as const).map((policy) => (
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
                  data-testid={`circle-edit-policy-${policy}`}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-reason-red"
                  {...register('joinPolicy')}
                />
                <span className="min-w-0 text-[14px] text-reason-ink">
                  <b>{POLICY_LABEL[policy]}:</b>{POLICY_COPY[policy].slice(POLICY_LABEL[policy].length + 1)}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {opening && (
          <p role="status" className="text-[13px] text-reason-muted">
            {waiting === 1 ? 'The person waiting to join will be let in.' : `The ${waiting} people waiting to join will be let in.`}
          </p>
        )}
        {errors.root && <p role="alert" className="text-[13px] text-reason-red">{errors.root.message}</p>}
      </form>
    </Sheet>
  );
}
