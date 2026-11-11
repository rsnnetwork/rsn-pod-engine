// One voice note, played (Shirley Palmer, 11 Nov 2026, RSN 06): a 44px play / pause, a progress bar, and
// "elapsed / total", the same for a note not yet sent, one sent and one received. The browser's own <audio controls>
// is gone: on a webm fresh from MediaRecorder it knew no length, so its clock ran on past the end. The total here is
// the length known with the note (the recorder's measure, or the length stored with a sent one), the file's own only
// when none is known (voiceTotalMs), and the clock and the bar are held at it (playbackClock).

import { useRef, useState, type ReactNode } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { LENGTH_PROBE_SEC, VOICE_COPY, needsLengthProbe, playbackClock, voiceTotalMs } from './voice-note';

interface Props {
  /** null until the address is ready (a draft's is made after its first render): the button waits, nothing loads. */
  src: string | null;
  /** The length recorded with the note, if any (a sent note's Cloudinary length, a draft's recorded length). */
  durationMs: number | null;
  tone: 'own' | 'theirs' | 'draft';
  testId?: string;
  /** A word under the clock: "Sent", "Not sent", "Sending…". */
  status?: ReactNode;
}

export default function VoiceNotePlayer({ src, durationMs, tone, testId, status }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [fileSec, setFileSec] = useState<number | null>(null);
  // While the browser is made to work out a length it did not know (needsLengthProbe), its jump to the end is not shown.
  const probing = useRef(false);
  const total = voiceTotalMs(fileSec, durationMs);
  const clock = playbackClock(currentSec, total);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (!a.paused) { a.pause(); return; }
    if (a.ended || (total !== null && a.currentTime * 1000 >= total)) a.currentTime = 0;
    a.play().catch(() => setPlaying(false));
  };

  const onLength = (a: HTMLAudioElement) => {
    if (!probing.current && needsLengthProbe(a.duration, durationMs)) {
      probing.current = true;
      a.currentTime = LENGTH_PROBE_SEC;
      return;
    }
    if (probing.current && Number.isFinite(a.duration)) {
      probing.current = false;
      a.currentTime = 0;
    }
    setFileSec(a.duration);
  };

  const onTime = () => {
    const a = audioRef.current;
    if (!a || probing.current) return;
    const next = playbackClock(a.currentTime, total);
    if (next.overran) { a.pause(); setCurrentSec(total! / 1000); return; }
    setCurrentSec(a.currentTime);
  };

  const track = tone === 'draft' ? 'bg-amber-100' : 'bg-gray-200';
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={testId}>
      <button
        type="button"
        onClick={toggle}
        disabled={!src}
        aria-label={playing ? VOICE_COPY.pause : VOICE_COPY.play}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-rsn-red ring-1 ring-gray-200 hover:bg-gray-50"
      >
        {playing ? <Pause className="h-5 w-5" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="progressbar"
          aria-label="Voice note progress"
          aria-valuemin={0}
          aria-valuemax={total === null ? undefined : Math.round(total / 1000)}
          aria-valuenow={Math.round(clock.elapsedMs / 1000)}
          className={`h-1.5 w-full overflow-hidden rounded-full ${track}`}
        >
          <div className="h-full rounded-full bg-rsn-red" style={{ width: `${Math.round(clock.progress * 100)}%` }} />
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-600">
          <Mic className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span className="tabular-nums">{clock.label}</span>
          {status && <span className="ml-auto shrink-0 font-medium">{status}</span>}
        </div>
      </div>
      {src && <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(e) => onLength(e.currentTarget)}
        onDurationChange={(e) => onLength(e.currentTarget)}
        onTimeUpdate={onTime}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentSec(total !== null ? total / 1000 : currentSec); }}
      />}
    </div>
  );
}
