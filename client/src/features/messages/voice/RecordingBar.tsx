// While a voice note records, this bar takes the message box's place: a pulsing dot, the time so far, a countdown in
// the last 10 seconds before the 1 minute cap, the live waveform, Cancel, and Stop in words (RSN 05/06, 11 Nov 2026).
// Stop does not send: it leads to the note's preview, where Send voice note is its own button.

import type { RefObject } from 'react';
import { Square as StopSquare, X } from 'lucide-react';
import { VOICE_COPY, recordingClock } from './voice-note';

interface Props {
  elapsedMs: number;
  starting: boolean;
  canvasRef: RefObject<HTMLCanvasElement>;
  onCancel: () => void;
  onStop: () => void;
}

export default function RecordingBar({ elapsedMs, starting, canvasRef, onCancel, onStop }: Props) {
  const clock = recordingClock(elapsedMs);
  return (
    <div className="flex items-center gap-2 px-1 py-1 sm:gap-3 sm:px-2" data-testid="dm-recording-bar">
      <span className="inline-block h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-rsn-red" aria-hidden="true" />
      <span className="shrink-0 font-mono text-sm tabular-nums text-gray-700" aria-label={`${VOICE_COPY.recording} ${clock.label}`}>
        {clock.label}
      </span>
      {clock.secondsLeft !== null && (
        <span className="shrink-0 text-xs font-semibold text-rsn-red" aria-live="polite" data-testid="dm-recording-countdown">
          {VOICE_COPY.secondsLeft(clock.secondsLeft)}
        </span>
      )}
      <canvas
        ref={canvasRef}
        width={400}
        height={36}
        className="h-9 min-w-0 flex-1 rounded-md bg-gray-50"
        aria-label="Recording waveform"
        data-testid="dm-recording-waveform"
      />
      <button
        type="button"
        onClick={onCancel}
        aria-label={VOICE_COPY.cancel}
        title={VOICE_COPY.cancel}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
      >
        <X className="h-5 w-5 sm:h-4 sm:w-4" />
      </button>
      <button
        type="button"
        onClick={onStop}
        disabled={starting}
        className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full bg-rsn-red px-4 text-sm font-semibold text-white transition-colors hover:bg-rsn-red/90 disabled:opacity-60"
        data-testid="dm-recording-stop"
      >
        <StopSquare className="h-4 w-4" aria-hidden="true" />
        {VOICE_COPY.stop}
      </button>
    </div>
  );
}
