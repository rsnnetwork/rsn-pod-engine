// ─── Call request UI (9 Sep 2026, Ali/Stefan) ───────────────────────────────
//
// Calls go request → accept. CallRequestModal: the caller picks video/audio and TYPES a duration (Stefan,
// 9 Sep: "choose the intended duration"), starting at 15 minutes of video so it is one tap and Send.
// 1 Nov 2026: the caller's "Calling…" card and the callee's banner are app-wide now
// (features/calls/OutgoingCallCard.tsx, components/ui/IncomingCallBanner.tsx), so a call rung from a profile
// or a thread waits, rings and enters the room on every screen; the thread's own copies of them are gone.

import { useEffect, useState } from 'react';
import { Video, Phone } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

export const CALL_MIN = 5;
export const CALL_MAX = 240;

export function CallRequestModal({ open, kind, partnerName, onClose, onSend, sending, videoOnly = false }: {
  open: boolean;
  kind: 'audio' | 'video';
  partnerName: string | null;
  onClose: () => void;
  onSend: (kind: 'audio' | 'video', durationMin: number) => void;
  sending: boolean;
  /** A profile rings video only (audio stays in the thread), so it offers no choice of kind. */
  videoOnly?: boolean;
}) {
  const [chosenKind, setChosenKind] = useState<'audio' | 'video'>(kind);
  const [minutes, setMinutes] = useState<string>('15');
  useEffect(() => { if (open) { setChosenKind(videoOnly ? 'video' : kind); setMinutes('15'); } }, [open, kind, videoOnly]);

  const n = Number(minutes);
  const valid = Number.isFinite(n) && n >= CALL_MIN && n <= CALL_MAX;

  return (
    <Modal open={open} onClose={onClose} title={`Call ${partnerName || 'them'}`}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (valid) onSend(chosenKind, Math.round(n)); }}
        className="space-y-4"
      >
        <p className="text-xs text-gray-500">
          They'll get a request with the length you choose, and the call starts once they accept.
        </p>
        {!videoOnly && (<div>
          <p className="mb-1.5 block text-sm font-medium text-gray-600">Type</p>
          <div className="inline-flex overflow-hidden rounded-xl border border-gray-200">
            {(['video', 'audio'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setChosenKind(k)}
                className={`inline-flex min-h-[44px] items-center gap-1.5 px-4 text-sm font-medium ${chosenKind === k ? 'bg-rsn-red text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
              >
                {k === 'video' ? <Video className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
                {k === 'video' ? 'Video' : 'Audio'}
              </button>
            ))}
          </div>
        </div>)}
        <div>
          <label htmlFor="call-minutes" className="mb-1.5 block text-sm font-medium text-gray-600">
            How long? (minutes)
          </label>
          <input
            id="call-minutes"
            type="number"
            inputMode="numeric"
            min={CALL_MIN}
            max={CALL_MAX}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] min-h-[44px]"
          />
          {!valid && minutes !== '' && (
            <p className="mt-1 text-xs text-red-500">Enter a number between {CALL_MIN} and {CALL_MAX}.</p>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">Cancel</Button>
          <Button type="submit" disabled={!valid} isLoading={sending} className="min-h-[44px]">
            Send request
          </Button>
        </div>
      </form>
    </Modal>
  );
}
