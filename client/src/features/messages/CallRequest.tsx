// ─── Call request UI (9 Sep 2026, Ali/Stefan) ───────────────────────────────
//
// Once a pair's first meeting has happened, calls go request → accept:
//  - CallRequestModal: the caller picks video/audio and TYPES a duration.
//  - CallWaitingCard: the caller waits for an answer (can withdraw).
//  - IncomingCallCard: an in-thread Accept/Decline for a request that's still
//    live after a refresh (the global banner only catches the live socket event).

import { useEffect, useState } from 'react';
import { Video, Phone, X, Check } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

export const CALL_MIN = 5;
export const CALL_MAX = 240;

export function CallRequestModal({ open, kind, partnerName, onClose, onSend, sending }: {
  open: boolean;
  kind: 'audio' | 'video';
  partnerName: string | null;
  onClose: () => void;
  onSend: (kind: 'audio' | 'video', durationMin: number) => void;
  sending: boolean;
}) {
  const [chosenKind, setChosenKind] = useState<'audio' | 'video'>(kind);
  const [minutes, setMinutes] = useState<string>('15');
  useEffect(() => { if (open) { setChosenKind(kind); setMinutes('15'); } }, [open, kind]);

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
        <div>
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
        </div>
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

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function CallWaitingCard({ partnerName, kind, durationMin, expiresAt, onCancel }: {
  partnerName: string | null;
  kind: 'audio' | 'video';
  durationMin: number;
  expiresAt: number;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const Icon = kind === 'audio' ? Phone : Video;
  return (
    <div
      className="fixed bottom-24 left-1/2 z-[90] w-[92%] max-w-sm -translate-x-1/2 rounded-2xl border border-gray-200 bg-white p-4 shadow-xl"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      role="status"
      data-testid="call-waiting"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rsn-red-light text-rsn-red">
          <Icon className="h-5 w-5 animate-pulse" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#1a1a2e]">Waiting for {partnerName || 'them'} to accept…</p>
          <p className="text-xs text-gray-500">{durationMin}-min {kind} call · {mmss(expiresAt - now)}</p>
        </div>
        <button
          onClick={onCancel}
          className="inline-flex min-h-[40px] shrink-0 items-center gap-1 rounded-lg border border-gray-200 px-3 text-sm text-gray-600 hover:bg-gray-50"
        >
          <X className="h-4 w-4" /> Cancel
        </button>
      </div>
    </div>
  );
}

export function IncomingCallCard({ fromName, kind, durationMin, onAccept, onDecline, busy }: {
  fromName: string | null;
  kind: 'audio' | 'video';
  durationMin: number;
  onAccept: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  const Icon = kind === 'audio' ? Phone : Video;
  return (
    <div className="border-b border-rsn-red/20 bg-rsn-red-light/40 px-4 py-2.5" data-testid="incoming-call-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-rsn-red" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#1a1a2e]">{fromName || 'They'} want{fromName ? 's' : ''} to call</p>
            <p className="text-[11px] text-gray-500">{durationMin}-min {kind} call</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={onAccept} disabled={busy} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            <Check className="h-4 w-4" /> Accept
          </button>
          <button onClick={onDecline} disabled={busy} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <X className="h-4 w-4" /> Decline
          </button>
        </div>
      </div>
    </div>
  );
}
