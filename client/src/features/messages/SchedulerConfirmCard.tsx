// The confirm card: one time both people saved, with the meeting's length and kind, and the one button that books it
// ("Confirm meeting") or, with a meeting already standing, moves it there ("Move meeting"). Length and kind live here,
// the one place they are used (26 Oct 2026: a bare number box at the top of the panel read as "choose the hour").
// A time that stops being free for both while the card is open stays on the card with the reason, and the button
// waits until it is shared again.

import type { RefObject } from 'react';
import { Check, Phone, Video } from 'lucide-react';
import { MAX_DURATION, MIN_DURATION, NOT_SHARED, meetingLength, slotLabel } from './scheduler-flow';

interface Props {
  cardRef: RefObject<HTMLDivElement>;
  slot: string;
  zone: string;
  /** The zone named for the reader: "Central European Time (CET)". */
  zoneText: string;
  /** A meeting stands: this card moves it. */
  moving: boolean;
  /** Both people still have this time saved. */
  stillShared: boolean;
  durationText: string;
  onDuration: (text: string) => void;
  kind: 'audio' | 'video';
  onKind: (kind: 'audio' | 'video') => void;
  /** Some confirm is on its way; this one, if it is for this time. */
  busy: boolean;
  sendingThis: boolean;
  /** The time is one of the member's own saved picks, so it can be taken back from here. */
  canRemove: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}

export default function SchedulerConfirmCard({
  cardRef, slot, zone, zoneText, moving, stillShared, durationText, onDuration, kind, onKind,
  busy, sendingThis, canRemove, onConfirm, onCancel, onRemove,
}: Props) {
  const minutes = meetingLength(durationText);
  const label = slotLabel(slot, zone);
  return (
    <div ref={cardRef} className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 space-y-2.5" data-testid="confirm-card">
      <div>
        <p className="text-sm font-semibold text-emerald-900">{label}</p>
        <p className="text-[11px] text-emerald-800">
          {moving ? 'Your meeting moves to this time. ' : ''}{zoneText}. They see it in their own time.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="meeting-length">
        <label htmlFor="meeting-minutes" className="text-xs font-medium text-emerald-900">Length</label>
        <input
          id="meeting-minutes"
          type="number"
          inputMode="numeric"
          min={MIN_DURATION}
          max={MAX_DURATION}
          step={5}
          value={durationText}
          onChange={e => onDuration(e.target.value)}
          aria-invalid={minutes === null}
          aria-describedby="confirm-summary"
          className={`h-11 w-20 rounded-lg border bg-white px-2 text-sm text-gray-800 ${minutes !== null ? 'border-emerald-300' : 'border-rsn-red'}`}
        />
        <span className="text-xs text-emerald-900">min</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-emerald-300" role="group" aria-label="Kind of call">
          {(['video', 'audio'] as const).map(k => (
            <button
              key={k}
              type="button"
              onClick={() => onKind(k)}
              aria-pressed={kind === k}
              className={`inline-flex min-h-[44px] items-center gap-1 px-3 text-xs font-medium ${kind === k ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-800'}`}
            >
              {k === 'video' ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
              {k === 'video' ? 'Video' : 'Audio'}
            </button>
          ))}
        </div>
      </div>
      <p id="confirm-summary" className="text-xs text-emerald-900" data-testid="confirm-summary">
        {minutes !== null
          ? `${label} · ${minutes} min · ${kind === 'audio' ? 'Audio' : 'Video'} call`
          : `Length must be ${MIN_DURATION}–${MAX_DURATION} minutes.`}
      </p>
      {!stillShared && (
        <p className="text-xs font-medium text-rsn-red" role="status" data-testid="confirm-card-not-shared">{NOT_SHARED}</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          disabled={busy || minutes === null || !stillShared}
          className="flex-1 min-h-[44px] flex items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          {sendingThis
            ? (moving ? 'Moving…' : 'Confirming…')
            : (moving ? 'Move meeting' : 'Confirm meeting')}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="min-h-[44px] text-sm font-medium text-emerald-900 underline underline-offset-2 hover:text-emerald-700"
        >
          Remove this time
        </button>
      )}
    </div>
  );
}
