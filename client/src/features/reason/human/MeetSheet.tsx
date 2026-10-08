// The v4 prototype's Meet modal: a "Why now?" note and a preferred format, sent as a meeting request.
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MEET_NOTE_MAX, MEETING_FORMATS, type MeetingFormat } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '../ui/Sheet';
import { errorMessage, reasonKeys, sendMeetRequest } from '../api';

// The prototype's own default text.
const DEFAULT_NOTE = 'I think we have a useful reason to speak. I would like to compare notes and see whether there is anything worth continuing.';
const DEFAULT_FORMAT: MeetingFormat = 'video_20';
const CANCEL = 'min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold';
const SEND = 'min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white enabled:hover:bg-reason-red-hover disabled:opacity-60';

interface Props { person: { userId: string; displayName: string } | null; onClose: () => void }
// A request carries everything it needs, so it can finish after the parent has closed the sheet.
interface MeetRequest { userId: string; displayName: string; note: string; format: MeetingFormat }

export default function MeetSheet({ person, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const personId = person?.userId ?? null;
  const counterId = useId();
  const hintId = useId();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const [note, setNote] = useState(DEFAULT_NOTE);
  const [format, setFormat] = useState<MeetingFormat>(DEFAULT_FORMAT);
  const [error, setError] = useState<string | null>(null);

  // A fresh form each time the sheet opens for someone. It follows the person's id and not the `person`
  // object: the Human Profile hands over a new object on every render, and every refetch there would
  // otherwise put the default text back over what the member is typing. It is done while rendering and
  // not in an effect, because an effect runs after the first render and the reopened sheet would show
  // the last answers for a moment.
  const [formFor, setFormFor] = useState(personId);
  if (formFor !== personId) {
    setFormFor(personId);
    if (personId) {
      setNote(DEFAULT_NOTE);
      setFormat(DEFAULT_FORMAT);
      setError(null);
    }
  }

  // Who the sheet is open for right now. A request can settle after the member has closed the sheet, or
  // opened it for someone else: it then says how it went in a toast and leaves the sheet alone.
  const shownFor = useRef(personId);
  useEffect(() => { shownFor.current = personId; }, [personId]);
  // The error is the last thing in a body that scrolls: with the phone keyboard up it would land below the fold.
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);

  // The people a request is out for. A ref, not isPending: a double tap lands before React re-renders the
  // button as disabled, and each tap would otherwise send its own request.
  const inFlight = useRef(new Set<string>());

  // networkMode 'always': by default a request made while the browser says it is offline is held until the
  // network returns, so the sheet would read "Sending…" for as long as the member stays offline and the
  // request would go out by itself, minutes later, after the sheet was closed. Attempted at once, it fails
  // with no response and errorMessage says the connection was lost.
  const send = useMutation({
    networkMode: 'always',
    mutationFn: (r: MeetRequest) => sendMeetRequest(r.userId, r.note, r.format),
    onSuccess: (_sent, r) => {
      addToast(`Meeting request sent to ${r.displayName}`, 'success');
      qc.invalidateQueries({ queryKey: reasonKeys.all });
      if (shownFor.current === r.userId) onClose();
    },
    onError: (err, r) => {
      const message = errorMessage(err, 'Could not send that request. Try again in a moment.');
      if (shownFor.current === r.userId) setError(message);
      else addToast(`${r.displayName}: ${message}`, 'error');
    },
    // On the mutation, not on a .mutate() call: those callbacks are dropped once a later press (for someone
    // else) takes the observer over, which would leave the first person stuck.
    onSettled: (_data, _error, r) => { inFlight.current.delete(r.userId); },
  });
  // Only this person's request keeps the button waiting: another person's sheet is not held up by it.
  const pending = send.isPending && send.variables?.userId === personId;

  // What the route counts: the length of the trimmed note.
  const length = note.trim().length;
  const over = length > MEET_NOTE_MAX;
  const invalid = length === 0 || over;
  // The hint under the counter. While it shows it is also the Send button's description: the button is in the footer
  // and the hint in the body, so a screen reader that lands on the dimmed button would otherwise hear no reason.
  const hintShown = length === 0;
  const submit = () => {
    if (!person || inFlight.current.has(person.userId) || invalid) return;
    inFlight.current.add(person.userId);
    setError(null);
    send.mutate({ userId: person.userId, displayName: person.displayName, note: note.trim(), format });
  };

  return (
    <Sheet
      open={!!person}
      onClose={onClose}
      title={person ? `Meet ${person.displayName}` : 'Meet'}
      footer={(
        <>
          <button type="button" onClick={onClose} className={CANCEL}>Cancel</button>
          <button type="button" onClick={submit} disabled={pending || invalid} aria-describedby={hintShown ? hintId : undefined} className={SEND}>
            {pending ? 'Sending…' : 'Send request'}
          </button>
        </>
      )}
    >
      <p className="mt-1 text-[13px] text-reason-muted">REASON will send a meeting request with the reason attached, so the conversation starts with context.</p>
      <label className="mt-3.5 grid gap-1.5 text-[12px] font-bold">
        Why now?
        <textarea
          value={note}
          onChange={(e) => { setNote(e.target.value); setError(null); }}
          aria-describedby={counterId}
          rows={4}
          className="min-h-[90px] resize-y rounded-[11px] border border-reason-line p-3 text-[16px] font-normal md:text-[14px]"
        />
      </label>
      <p id={counterId} className={cn('mt-1 text-[11px]', over ? 'text-reason-red' : 'text-reason-muted')}>{length} / {MEET_NOTE_MAX}</p>
      {hintShown && <p id={hintId} className="mt-1 text-[11px] text-reason-muted">Write a short note first.</p>}
      <label className="mt-3 grid gap-1.5 text-[12px] font-bold">
        Preferred format
        <select
          value={format}
          onChange={(e) => { setFormat(e.target.value as MeetingFormat); setError(null); }}
          className="min-h-[44px] rounded-[11px] border border-reason-line bg-white px-3 text-[16px] font-normal md:text-[14px]"
        >
          {MEETING_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </label>
      {error && <p ref={errorLine} role="alert" className="mt-3 text-[13px] text-reason-red">{error}</p>}
    </Sheet>
  );
}
