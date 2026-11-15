// ─── A platform admin makes a circle directly (REASON v1 Phase 3a; Ben field test, 13 Nov 2026) ───────────────────
// Its name, description and who can join, chosen before it exists: a circle is closed from its first moment unless the
// admin chooses otherwise (on 13 Nov a new circle was open for the minute before it was closed, and someone joined).
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { CircleJoinPolicy } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import api from '@/lib/api';
import { CIRCLE_DESCRIPTION_MAX, CIRCLE_NAME_MAX, CIRCLE_NAME_MIN } from './circle-admin';
import { NEW_CIRCLE_POLICY } from './circle-logic';
import CirclePolicyField from './CirclePolicyField';
import { circleErrorSentence } from './useCircleActions';

interface Values { name: string; description: string; joinPolicy: CircleJoinPolicy }

export default function NewCircleSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { register, handleSubmit, watch, setError, formState: { errors } } = useForm<Values>({
    defaultValues: { name: '', description: '', joinPolicy: NEW_CIRCLE_POLICY },
  });
  const create = useMutation({
    networkMode: 'always',
    mutationFn: (v: Values) => api.post('/circles', {
      name: v.name.trim(), description: v.description.trim() || null, joinPolicy: v.joinPolicy,
    }).then((r) => r.data.data as { id: string }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ['circles'] });
      onClose();
      navigate(`/circles/${id}`);
    },
    onError: (err) => setError('root', { message: circleErrorSentence(err, 'The circle could not be created. Try again.') }),
  });
  const submit = handleSubmit((v) => { if (!create.isPending) create.mutate(v); });

  return (
    <Sheet
      open
      onClose={() => { if (!create.isPending) onClose(); }}
      title="New circle"
      footer={(
        <>
          <Button variant="ghost" type="button" onClick={onClose} disabled={create.isPending} className="min-h-[44px]">Cancel</Button>
          <Button type="button" onClick={() => void submit()} isLoading={create.isPending} data-testid="circle-new-create" className="min-h-[44px]">Create circle</Button>
        </>
      )}
    >
      <form className="mt-2 space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate data-testid="circle-new-form">
        <Input
          label="Circle name"
          placeholder="e.g. Founders"
          data-testid="circle-new-name"
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
          <label htmlFor="circle-new-description" className="block text-sm font-medium text-gray-600 mb-1.5">Description</label>
          <textarea
            id="circle-new-description"
            rows={2}
            maxLength={CIRCLE_DESCRIPTION_MAX}
            placeholder="What is this circle about?"
            data-testid="circle-new-description"
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-base sm:text-[15px] text-gray-900 focus:border-rsn-red focus:outline-none"
            {...register('description', {
              maxLength: { value: CIRCLE_DESCRIPTION_MAX, message: `Keep the description to ${CIRCLE_DESCRIPTION_MAX} characters.` },
            })}
          />
          {errors.description && <p role="alert" className="mt-1 text-[13px] text-reason-red">{errors.description.message}</p>}
        </div>
        <CirclePolicyField field={register('joinPolicy')} choice={watch('joinPolicy')} testId="circle-new-policy" />
        {errors.root && <p role="alert" className="text-[13px] text-reason-red">{errors.root.message}</p>}
      </form>
    </Sheet>
  );
}
