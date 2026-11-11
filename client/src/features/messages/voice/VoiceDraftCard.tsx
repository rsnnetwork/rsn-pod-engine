// A stopped voice note, not yet sent (Shirley Palmer, 11 Nov 2026, RSN 05): Record → Stop → this preview → Send voice
// note or Discard. It says "Not sent" until the server has it, names who it is for, and plays with its length shown.
// It takes the message box's place, so the only way on is one of its two labelled buttons.

import { useEffect, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import VoiceNotePlayer from './VoiceNotePlayer';
import { VOICE_COPY } from './voice-note';
import type { VoiceDraft } from './composer-drafts';

interface Props {
  voice: VoiceDraft;
  recipientName: string | null;
  /** 0..1 while the note uploads in this box; null otherwise. */
  uploadFraction: number | null;
  /** Longer than an upload accepts (the recorder's timers were held): said, and Send is off. */
  tooLong: boolean;
  onSend: () => void;
  onDiscard: () => void;
}

export default function VoiceDraftCard({ voice, recipientName, uploadFraction, tooLong, onSend, onDiscard }: Props) {
  // Made and revoked by the same effect, so StrictMode's mount, clean-up, mount in development leaves a live address.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(voice.blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [voice.blob]);
  const status = voice.sending
    ? `${VOICE_COPY.sending}${uploadFraction !== null ? ` ${Math.round(uploadFraction * 100)}%` : ''}`
    : VOICE_COPY.notSent;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2" data-testid="dm-voice-draft">
      <p className="mb-1 flex items-center gap-2 text-xs text-amber-900">
        <span className="rounded-full bg-amber-200 px-2 py-0.5 font-semibold" data-testid="dm-voice-draft-status">{status}</span>
        <span className="min-w-0 truncate">Voice note to {recipientName || 'this person'}</span>
      </p>
      <VoiceNotePlayer src={src} durationMs={voice.durationMs} tone="draft" testId="dm-audio-preview" />
      {tooLong && (
        <p role="alert" className="mt-2 text-sm font-medium text-rsn-red" data-testid="dm-voice-too-long">{VOICE_COPY.tooLong}</p>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDiscard}
          disabled={voice.sending}
          className="flex min-h-[44px] items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-gray-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="dm-voice-discard"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {VOICE_COPY.discard}
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={voice.sending || tooLong}
          className="flex min-h-[44px] items-center gap-1.5 rounded-full bg-rsn-red px-4 text-sm font-semibold text-white hover:bg-rsn-red/90 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="dm-voice-send"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {VOICE_COPY.send}
        </button>
      </div>
    </div>
  );
}
