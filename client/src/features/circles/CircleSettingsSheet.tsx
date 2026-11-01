// ─── "Who can join", for the people who run a circle (T14, 1 Nov 2026; 30 Oct review 7.5) ─────────────────────────
// Two choices in the pod form's wording style. Saving Open lets everyone still waiting in (the server approves them).
import { useState } from 'react';
import type { CircleJoinPolicy } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { POLICY_COPY, POLICY_LABEL, WHO_CAN_JOIN } from './circle-logic';
import { circleErrorSentence, useJoinPolicy } from './useCircleActions';

interface Props { circleId: string; name: string; current: CircleJoinPolicy; waiting: number; onClose: () => void }

export default function CircleSettingsSheet({ circleId, name, current, waiting, onClose }: Props) {
  const [choice, setChoice] = useState<CircleJoinPolicy>(current);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);
  const save = useJoinPolicy(circleId);
  const opening = current === 'closed' && choice === 'open' && waiting > 0;

  const submit = () => {
    if (save.isPending) return;
    if (choice === current) { onClose(); return; }
    setError(null);
    save.mutate(choice, {
      onSuccess: () => {
        addToast(choice === 'closed' ? `${name} is closed. People now ask to join.` : `${name} is open. Anyone on REASON can join.`, 'success');
        onClose();
      },
      onError: (err) => setError(circleErrorSentence(err, 'That could not be saved. Try again.')),
    });
  };

  return (
    <Sheet
      open
      onClose={() => { if (!save.isPending) onClose(); }}
      title={WHO_CAN_JOIN}
      footer={(
        <>
          <Button variant="ghost" type="button" onClick={onClose} disabled={save.isPending} className="min-h-[44px]">Cancel</Button>
          <Button type="button" onClick={submit} isLoading={save.isPending} data-testid="circle-policy-save" className="min-h-[44px]">Save</Button>
        </>
      )}
    >
      <fieldset className="mt-3 grid gap-2">
        <legend className="sr-only">{WHO_CAN_JOIN}</legend>
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
              name="join-policy"
              value={policy}
              checked={choice === policy}
              onChange={() => setChoice(policy)}
              data-testid={`circle-policy-${policy}`}
              className="mt-0.5 h-5 w-5 shrink-0 accent-reason-red"
            />
            {/* The words are the review's, verbatim: "Open: anyone on REASON can join." with its label in bold. */}
            <span className="min-w-0 text-[14px] text-reason-ink">
              <b>{POLICY_LABEL[policy]}:</b>{POLICY_COPY[policy].slice(POLICY_LABEL[policy].length + 1)}
            </span>
          </label>
        ))}
      </fieldset>
      {opening && (
        <p role="status" className="mt-3 text-[13px] text-reason-muted">
          {waiting === 1 ? 'The person waiting to join will be let in.' : `The ${waiting} people waiting to join will be let in.`}
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-[13px] text-reason-red">{error}</p>}
    </Sheet>
  );
}
