// The voice-note recorder, without React (Shirley Palmer, 11 Nov 2026, RSN 01/05/06). useVoiceRecorder wraps it for
// the message box; the server's jest runs it against a fake microphone and clock.
//
// Record → Stop hands the take over once, with its length, through onRecorded. The take stops by itself at
// VOICE_NOTE_MAX_MS ('cap'). dispose() is called when the box unmounts (another conversation opened, the page left):
// a running take is stopped and handed over as 'left', to the SAME onRecorded, so it is kept in the conversation it
// was recorded in and never in the one now open. A take still waiting for the microphone is abandoned and the
// microphone released.
//
// Recording details kept from 15 May (the "missing last seconds" fix): no timeslice, so the whole take arrives on stop;
// requestData() ~120ms before stop() so the tail is flushed first; cancel is a flag onstop reads, not chunks cleared
// under the recorder. No browser API is touched here: useVoiceRecorder hands in the real microphone and MediaRecorder.

import { VOICE_NOTE_MAX_MS, VOICE_NOTE_MIN_MS, VOICE_COPY, micErrorSentence, recordingClock } from './voice-note';

export interface MediaRecorderLike {
  readonly state: string;
  readonly mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
  requestData(): void;
}

/** What the recorder needs of a microphone stream: its tracks, to release them. */
export interface StreamLike {
  getTracks: () => Array<{ stop: () => void }>;
}

export interface RecorderDeps<S extends StreamLike = StreamLike> {
  supported: () => boolean;
  getUserMedia: () => Promise<S>;
  createRecorder: (stream: S) => MediaRecorderLike;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  setTimeout: (fn: () => void, ms: number) => void;
}

export type RecorderState = 'idle' | 'starting' | 'recording';
export type TakeEnd = 'stopped' | 'cap' | 'left';

export interface RecorderEvents<S extends StreamLike = StreamLike> {
  onState: (state: RecorderState) => void;
  onTick: (elapsedMs: number) => void;
  onRecorded: (blob: Blob, durationMs: number, how: TakeEnd) => void;
  onError: (sentence: string) => void;
  /** The live microphone, for the waveform; null once released. */
  onStream?: (stream: S | null) => void;
}

export interface VoiceRecorder {
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  dispose: () => void;
  state: () => RecorderState;
}

const FLUSH_BEFORE_STOP_MS = 120;
const TICK_MS = 100;

export function createVoiceRecorder<S extends StreamLike>(deps: RecorderDeps<S>, events: RecorderEvents<S>): VoiceRecorder {
  let state: RecorderState = 'idle';
  let recorder: MediaRecorderLike | null = null;
  let stream: S | null = null;
  let timer: number | null = null;
  let startedAt = 0;
  let chunks: Blob[] = [];
  let cancelled = false;
  let disposed = false;
  let ending: TakeEnd | null = null;

  const setState = (next: RecorderState) => {
    state = next;
    if (!disposed) events.onState(next);
  };

  const release = () => {
    if (timer !== null) { deps.clearInterval(timer); timer = null; }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    events.onStream?.(null);
  };

  const end = (how: TakeEnd) => {
    if (state !== 'recording' || !recorder || ending) return;
    ending = how;
    if (timer !== null) { deps.clearInterval(timer); timer = null; }
    const r = recorder;
    try { r.requestData(); } catch { /* an old recorder without requestData still stops with its whole take */ }
    deps.setTimeout(() => { if (r.state === 'recording') r.stop(); }, FLUSH_BEFORE_STOP_MS);
  };

  const start = async () => {
    if (state !== 'idle' || disposed) return;
    if (!deps.supported()) { events.onError(VOICE_COPY.unsupported); return; }
    cancelled = false;
    ending = null;
    setState('starting');
    let granted: S;
    try {
      granted = await deps.getUserMedia();
    } catch (err) {
      setState('idle');
      if (!disposed) events.onError(micErrorSentence(err));
      return;
    }
    stream = granted;
    if (disposed || cancelled) { release(); setState('idle'); return; }
    let r: MediaRecorderLike;
    try {
      r = deps.createRecorder(granted);
    } catch (err) {
      release();
      setState('idle');
      events.onError(micErrorSentence(err));
      return;
    }
    chunks = [];
    r.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    r.onstop = () => {
      const durationMs = deps.now() - startedAt;
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
      const how = ending ?? 'stopped';
      chunks = [];
      recorder = null;
      ending = null;
      release();
      setState('idle');
      if (cancelled || blob.size === 0 || durationMs < VOICE_NOTE_MIN_MS) { cancelled = false; return; }
      events.onRecorded(blob, durationMs, how);
    };
    recorder = r;
    r.start();
    startedAt = deps.now();
    events.onTick(0);
    events.onStream?.(granted);
    setState('recording');
    timer = deps.setInterval(() => {
      const elapsed = deps.now() - startedAt;
      events.onTick(Math.min(elapsed, VOICE_NOTE_MAX_MS));
      if (recordingClock(elapsed).reachedCap) end('cap');
    }, TICK_MS);
  };

  const cancel = () => {
    cancelled = true;
    if (state !== 'recording' || !recorder) return;
    if (timer !== null) { deps.clearInterval(timer); timer = null; }
    try { recorder.stop(); } catch { release(); setState('idle'); }
  };

  return {
    start,
    stop: () => end('stopped'),
    cancel,
    dispose: () => {
      if (state === 'recording') end('left');
      else cancelled = true;
      disposed = true;
    },
    state: () => state,
  };
}
