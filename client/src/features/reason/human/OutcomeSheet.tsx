// Foundation S10 and the v4 prototype's outcome modal: was it worth continuing, and what came of it.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OUTCOME_KEYS, OUTCOME_LABELS, type OutcomeKey, type WorthContinuing } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '../ui/Sheet';
import { errorMessage, reasonKeys, recordOutcomeRequest } from '../api';

const WORTH: Array<{ key: WorthContinuing; label: string }> = [
  { key: 'yes', label: 'Yes' }, { key: 'maybe', label: 'Maybe' }, { key: 'no', label: 'No' },
];
const CANCEL = 'min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold';
const SAVE = 'min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white enabled:hover:bg-reason-red-hover disabled:opacity-60';
const CHIP = 'min-h-[44px] rounded-full border px-3.5 text-[13px] font-bold';
// A selected chip's text is the darker red: the brand red on this pink is 4.15:1, under AA.
const chip = (selected: boolean) => cn(CHIP, selected ? 'border-reason-red bg-reason-pink text-reason-red-hover' : 'border-reason-line');

interface Props { person: { userId: string; displayName: string } | null; onClose: () => void }
// A request carries everything it needs, so it can finish after the parent has closed the sheet.
interface OutcomeRequest { userId: string; displayName: string; worth: WorthContinuing; outcomes: OutcomeKey[] }

export default function OutcomeSheet({ person, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const personId = person?.userId ?? null;
  const [worth, setWorth] = useState<WorthContinuing | null>(null);
  const [picked, setPicked] = useState<OutcomeKey[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A fresh form each time the sheet opens for someone, keyed on the id and not on `person`, and done while
  // rendering so the reopened sheet never shows the last answers (see MeetSheet).
  const [formFor, setFormFor] = useState(personId);
  if (formFor !== personId) {
    setFormFor(personId);
    if (personId) {
      setWorth(null);
      setPicked([]);
      setError(null);
    }
  }

  // Who the sheet is open for right now: a save that settles after the sheet was closed or opened for
  // someone else says how it went in a toast and leaves the sheet alone (see MeetSheet).
  const shownFor = useRef(personId);
  useEffect(() => { shownFor.current = personId; }, [personId]);

  const save = useMutation({
    mutationFn: (r: OutcomeRequest) => recordOutcomeRequest(r.userId, r.worth, r.outcomes),
    onSuccess: (_saved, r) => {
      addToast(`Saved what happened with ${r.displayName}`, 'success');
      qc.invalidateQueries({ queryKey: reasonKeys.all });
      if (shownFor.current === r.userId) onClose();
    },
    onError: (err, r) => {
      const message = errorMessage(err, 'Could not save that right now.');
      if (shownFor.current === r.userId) setError(message);
      else addToast(message, 'error');
    },
  });

  const choose = (key: WorthContinuing) => { setWorth(key); setError(null); };
  const toggle = (key: OutcomeKey) => {
    setPicked((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));
    setError(null);
  };
  // Outcomes are a history, so a double tap would store the answer twice. A ref, not isPending: the
  // button is only disabled a moment after the press.
  const inFlight = useRef(false);
  const submit = () => {
    if (!person || !worth || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    save.mutate(
      { userId: person.userId, displayName: person.displayName, worth, outcomes: picked },
      { onSettled: () => { inFlight.current = false; } },
    );
  };

  return (
    <Sheet
      open={!!person}
      onClose={onClose}
      title={person ? `What happened with ${person.displayName}?` : 'What happened?'}
      footer={(
        <>
          <button type="button" onClick={onClose} className={CANCEL}>Cancel</button>
          <button type="button" onClick={submit} disabled={!worth || save.isPending} className={SAVE}>
            {save.isPending ? 'Saving…' : 'Save outcome'}
          </button>
        </>
      )}
    >
      <p className="mt-1 text-[13px] text-reason-muted">This is the moment REASON learns from the real relationship.</p>
      <fieldset className="mt-4">
        <legend className="text-[12px] font-bold">Worth continuing?</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {WORTH.map((w) => (
            <button key={w.key} type="button" aria-pressed={worth === w.key} onClick={() => choose(w.key)} className={chip(worth === w.key)}>
              {w.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-4">
        <legend className="text-[12px] font-bold">What came from the conversation?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {OUTCOME_KEYS.map((k) => (
            <button key={k} type="button" aria-pressed={picked.includes(k)} onClick={() => toggle(k)} className={chip(picked.includes(k))}>
              {OUTCOME_LABELS[k]}
            </button>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-[13px] text-reason-red">{error}</p>}
    </Sheet>
  );
}
