// Foundation S10 and the v4 prototype's outcome modal: was it worth continuing, and what came of it.
import { useEffect, useId, useRef, useState } from 'react';
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
  const hintId = useId();
  const errorLine = useRef<HTMLParagraphElement>(null);
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
  // The error is the last thing in a body that scrolls: with the phone keyboard up it would land below the fold.
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);

  // The people a save is out for. Outcomes are a history, so a double tap would store the answer twice. A ref,
  // not isPending: the button is only disabled a moment after the press.
  const inFlight = useRef(new Set<string>());

  // networkMode 'always': offline, a held request would leave the sheet on "Saving…" and store the answer by
  // itself, minutes later, when the network returned (see MeetSheet).
  const save = useMutation({
    networkMode: 'always',
    mutationFn: (r: OutcomeRequest) => recordOutcomeRequest(r.userId, r.worth, r.outcomes),
    onSuccess: (_saved, r) => {
      addToast(`Saved what happened with ${r.displayName}`, 'success');
      qc.invalidateQueries({ queryKey: reasonKeys.all });
      if (shownFor.current === r.userId) onClose();
    },
    onError: (err, r) => {
      const message = errorMessage(err, 'Could not save that right now.');
      if (shownFor.current === r.userId) setError(message);
      else addToast(`${r.displayName}: ${message}`, 'error');
    },
    // On the mutation, not on a .mutate() call (see MeetSheet).
    onSettled: (_data, _error, r) => { inFlight.current.delete(r.userId); },
  });
  // Only this person's save keeps the button waiting.
  const pending = save.isPending && save.variables?.userId === personId;
  // The hint under "Worth continuing?". While it shows it is also the Save button's description: the button is in the
  // footer and the hint in the body, so a screen reader that lands on the dimmed button would otherwise hear no reason.
  const hintShown = !worth;

  const choose = (key: WorthContinuing) => { setWorth(key); setError(null); };
  // "Nothing yet" says nothing came of it, so it cannot sit beside another outcome: choosing it clears the
  // others, and choosing any other clears it.
  const toggle = (key: OutcomeKey) => {
    setPicked((p) => {
      if (p.includes(key)) return p.filter((x) => x !== key);
      return key === 'nothing_yet' ? [key] : [...p.filter((x) => x !== 'nothing_yet'), key];
    });
    setError(null);
  };
  const submit = () => {
    if (!person || !worth || inFlight.current.has(person.userId)) return;
    inFlight.current.add(person.userId);
    setError(null);
    save.mutate({ userId: person.userId, displayName: person.displayName, worth, outcomes: picked });
  };

  return (
    <Sheet
      open={!!person}
      onClose={onClose}
      title={person ? `What happened with ${person.displayName}?` : 'What happened?'}
      footer={(
        <>
          <button type="button" onClick={onClose} className={CANCEL}>Cancel</button>
          <button type="button" onClick={submit} disabled={!worth || pending} aria-describedby={hintShown ? hintId : undefined} className={SAVE}>
            {pending ? 'Saving…' : 'Save outcome'}
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
        {hintShown && <p id={hintId} className="mt-1.5 text-[11px] text-reason-muted">Choose an answer first.</p>}
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
      {error && <p ref={errorLine} role="alert" className="mt-3 text-[13px] text-reason-red">{error}</p>}
    </Sheet>
  );
}
