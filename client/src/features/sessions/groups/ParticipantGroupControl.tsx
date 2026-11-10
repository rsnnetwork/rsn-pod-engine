// ─── A participant's group on the organiser's participant list: the chip and "Change group" (Part 2 Task 11) ────────
// The chip names the person's groups (the organiser's read of the groups carries each person's keys). Change group
// opens a small form (portalled Sheet, react-hook-form + Zod): one group, or several when the event allows it, or none.
// The server checks the keys, refuses while the event is live, audits, and tells every screen.
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Loader2, Tags } from 'lucide-react';
import type { EventGroup } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { organiserSentence } from '../organiser-errors';
import { FieldError, PRIMARY_BUTTON, QUIET_BUTTON } from '../organiser-ui';
import { GROUPS_COPY } from './group-form';
import { useSetParticipantGroups } from './useEventGroups';

interface Props {
  sessionId: string;
  userId: string;
  name: string;
  groups: EventGroup[];
  mine: string[];
  allowMultiple: boolean;
  /** Whether the organiser may change it now (not while the event is live or over). */
  canChange: boolean;
}

const schema = z.object({ keys: z.array(z.string()) });
type Values = z.infer<typeof schema>;
const CHOICE = 'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm';

export default function ParticipantGroupControl({ sessionId, userId, name, groups, mine, allowMultiple, canChange }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const setGroups = useSetParticipantGroups(sessionId);
  const [open, setOpen] = useState(false);
  const formId = useId();
  const form = useForm<Values>({ defaultValues: { keys: mine }, resolver: formResolver(schema) });
  const { reset } = form;
  useEffect(() => { if (open) reset({ keys: mine }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = form.watch('keys');

  const labels = groups.filter((g) => mine.includes(g.key)).map((g) => g.label);
  const pick = (key: string, on: boolean) => {
    const next = allowMultiple ? (on ? [...chosen, key] : chosen.filter((k) => k !== key)) : (on ? [key] : []);
    form.setValue('keys', next, { shouldDirty: true });
  };
  const submit = form.handleSubmit(({ keys }) => {
    setGroups.mutate({ userId, groupKeys: keys }, {
      onSuccess: () => { addToast(GROUPS_COPY.changed, 'success'); setOpen(false); },
      onError: (err) => form.setError('keys', { type: 'server', message: organiserSentence(err, GROUPS_COPY.fallback) }),
    });
  });

  return (
    <>
      <span
        data-testid="participant-group-chip"
        className={cn('max-w-[10rem] truncate rounded-full px-2.5 py-0.5 text-xs font-medium', labels.length ? 'bg-violet-50 text-violet-700' : 'bg-gray-100 text-gray-500')}
      >
        {labels.length ? labels.join(', ') : GROUPS_COPY.noGroup}
      </span>
      {canChange && (
        <button
          type="button"
          data-testid="participant-change-group"
          onClick={() => setOpen(true)}
          aria-label={`${GROUPS_COPY.changeGroup}: ${name}`}
          title={GROUPS_COPY.changeGroup}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
        >
          <Tags className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
      <Sheet
        open={open}
        onClose={() => { if (!setGroups.isPending) setOpen(false); }}
        title={GROUPS_COPY.changeTitle(name)}
        footer={(
          <>
            <button type="button" onClick={() => setOpen(false)} disabled={setGroups.isPending} className={QUIET_BUTTON}>Cancel</button>
            <button type="submit" form={formId} disabled={setGroups.isPending} className={PRIMARY_BUTTON}>
              {setGroups.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {GROUPS_COPY.changeSave}
            </button>
          </>
        )}
      >
        <form id={formId} onSubmit={submit} noValidate className="grid gap-2 pb-1 pt-1">
          {groups.map((g) => (
            <label key={g.key} className={cn(CHOICE, chosen.includes(g.key) ? 'border-rsn-red bg-rsn-red/5' : 'border-gray-200 bg-white')}>
              <input
                type={allowMultiple ? 'checkbox' : 'radio'}
                name="participant-group"
                checked={chosen.includes(g.key)}
                onChange={(e) => pick(g.key, e.target.checked)}
                className="h-4 w-4 shrink-0 accent-rsn-red"
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{g.label}</span>
            </label>
          ))}
          {!allowMultiple && (
            <label className={cn(CHOICE, chosen.length === 0 ? 'border-rsn-red bg-rsn-red/5' : 'border-gray-200 bg-white')}>
              <input type="radio" name="participant-group" checked={chosen.length === 0} onChange={() => form.setValue('keys', [], { shouldDirty: true })} className="h-4 w-4 shrink-0 accent-rsn-red" />
              <span>{GROUPS_COPY.noGroup}</span>
            </label>
          )}
          <FieldError message={form.formState.errors.keys?.message} />
        </form>
      </Sheet>
    </>
  );
}
