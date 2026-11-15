// ─── Ask for a new circle (Ben field test, 13 Nov 2026) ─────────────────────────────────────────────────────────────
// "Not everyone needs a Circle. A Circle represents a real community or organisation." A member says what the circle is
// called, who it is for and why it should exist, and who can join; a REASON admin reviews it. Nothing goes live until it
// is approved. Errors from the server (a name already taken, too many asks waiting) are said in the form.
import { useForm } from 'react-hook-form';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { useToastStore } from '@/stores/toastStore';
import { CIRCLE_DESCRIPTION_MAX, CIRCLE_NAME_MAX, CIRCLE_NAME_MIN } from './circle-admin';
import { NEW_CIRCLE_POLICY } from './circle-logic';
import CirclePolicyField from './CirclePolicyField';
import { circleErrorSentence } from './useCircleActions';
import { useRequestCircle, type CircleRequestValues } from './useCircleRequests';

export const PURPOSE_MIN = 10;
export const PURPOSE_MAX = 1000;
const TEXTAREA = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-base sm:text-[15px] text-gray-900 focus:border-rsn-red focus:outline-none';

export default function RequestCircleSheet({ onClose }: { onClose: () => void }) {
  const addToast = useToastStore((s) => s.addToast);
  const ask = useRequestCircle();
  const { register, handleSubmit, watch, setError, formState: { errors } } = useForm<CircleRequestValues>({
    defaultValues: { name: '', description: '', purpose: '', joinPolicy: NEW_CIRCLE_POLICY },
  });

  const submit = handleSubmit((values) => {
    if (ask.isPending) return;
    ask.mutate(values, {
      onSuccess: (made) => {
        addToast(`Your request for ${made.name} was sent. A REASON admin will review it.`, 'success');
        onClose();
      },
      onError: (err) => setError('root', { message: circleErrorSentence(err, 'Your request could not be sent. Try again.') }),
    });
  });

  return (
    <Sheet
      open
      onClose={() => { if (!ask.isPending) onClose(); }}
      title="Ask for a new circle"
      footer={(
        <>
          <Button variant="ghost" type="button" onClick={onClose} disabled={ask.isPending} className="min-h-[44px]">Cancel</Button>
          <Button type="button" onClick={() => void submit()} isLoading={ask.isPending} data-testid="circle-request-send" className="min-h-[44px]">Send request</Button>
        </>
      )}
    >
      <form className="mt-2 space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate data-testid="circle-request-form">
        <p className="text-[14px] text-reason-muted">
          A circle is for a real community or organisation. Tell us about it and a REASON admin will review your request.
          You will be its owner once it is approved.
        </p>
        <Input
          label="Circle name"
          placeholder="e.g. TRIIBE"
          data-testid="circle-request-name"
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
          <label htmlFor="circle-request-purpose" className="block text-sm font-medium text-gray-600 mb-1.5">Who is it for, and why should it exist?</label>
          <textarea
            id="circle-request-purpose"
            rows={3}
            maxLength={PURPOSE_MAX}
            placeholder="e.g. The TRIIBE founder community: about 100 founders who meet every month."
            data-testid="circle-request-purpose"
            className={TEXTAREA}
            aria-invalid={!!errors.purpose}
            {...register('purpose', {
              validate: (v) => {
                const n = v.trim().length;
                if (n < PURPOSE_MIN) return 'Say in a sentence who the circle is for and why it should exist.';
                if (n > PURPOSE_MAX) return `Keep this to ${PURPOSE_MAX} characters.`;
                return true;
              },
            })}
          />
          {errors.purpose && <p role="alert" className="mt-1 text-[13px] text-reason-red">{errors.purpose.message}</p>}
        </div>
        <div>
          <label htmlFor="circle-request-description" className="block text-sm font-medium text-gray-600 mb-1.5">Description <span className="font-normal text-gray-400">(optional, shown on the circle)</span></label>
          <textarea
            id="circle-request-description"
            rows={2}
            maxLength={CIRCLE_DESCRIPTION_MAX}
            data-testid="circle-request-description"
            className={TEXTAREA}
            {...register('description', {
              maxLength: { value: CIRCLE_DESCRIPTION_MAX, message: `Keep the description to ${CIRCLE_DESCRIPTION_MAX} characters.` },
            })}
          />
          {errors.description && <p role="alert" className="mt-1 text-[13px] text-reason-red">{errors.description.message}</p>}
        </div>
        <CirclePolicyField field={register('joinPolicy')} choice={watch('joinPolicy')} testId="circle-request-policy" />
        {errors.root && <p role="alert" className="text-[13px] text-reason-red">{errors.root.message}</p>}
      </form>
    </Sheet>
  );
}
