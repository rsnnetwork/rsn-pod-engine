// Voice notes in Messages: the cap, the clocks and the words (Shirley Palmer, 11 Nov 2026, RSN 05 and RSN 06).
// Pure, so the server's jest runs it (server/src/__tests__/client/shirley-voice-draft.test.ts).

/** The longest voice note, the one place it is set: recording stops by itself here. */
export const VOICE_NOTE_MAX_MS = 60_000;
/** The last stretch of a recording counts down, so the stop at the cap is never a surprise. */
export const VOICE_NOTE_COUNTDOWN_MS = 10_000;
/** A take shorter than this holds no speech (a tap on Record then Stop): it is dropped, not kept. */
export const VOICE_NOTE_MIN_MS = 250;
/**
 * The longest note an upload accepts: the cap plus the stop's moment of lag (the tail flush before stop). The cap is
 * enforced here, on the client, and by this upload check (lib/cloudinary.ts) only: the server cannot measure a voice
 * note (the length it stores is the one the client reports), so it has no duration check of its own (controller
 * ruling, 11 Nov 2026).
 */
export const VOICE_NOTE_UPLOAD_LIMIT_MS = VOICE_NOTE_MAX_MS + 5_000;
/** How far past its total a note may seem to play before the player stops it (a browser's last tick lands late). */
const OVERRUN_GRACE_MS = 1_000;

export const VOICE_COPY = {
  record: 'Record a voice note',
  recording: 'Recording',
  stop: 'Stop',
  cancel: 'Cancel recording',
  notSent: 'Not sent',
  sending: 'Sending…',
  sent: 'Sent',
  send: 'Send voice note',
  discard: 'Discard',
  play: 'Play voice note',
  pause: 'Pause voice note',
  discardTitle: 'Discard this voice note?',
  discardBody: 'It has not been sent. Once discarded it cannot be brought back.',
  tooLong: 'This voice note is longer than 60 seconds. Record a shorter one.',
  unsupported: "This browser can't record voice notes. Try the latest Chrome, Safari, Edge or Firefox.",
  capReached: 'Voice notes can be up to 1 minute long. Yours stopped at 1 minute and has not been sent.',
  sentTo: (name: string | null) => `Voice note sent to ${name || 'them'}.`,
  keptFor: (name: string | null) => `Your voice note to ${name || 'them'} was stopped and kept in your chat with them. It has not been sent.`,
  secondsLeft: (n: number) => `${n}s left`,
} as const;

/** m:ss, never negative, never NaN. */
export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safe / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

/** The recording bar: the time so far (never past the cap), the seconds left in the last ten, and whether to stop. */
export function recordingClock(elapsedMs: number): { label: string; secondsLeft: number | null; reachedCap: boolean } {
  const shown = Math.min(Math.max(elapsedMs, 0), VOICE_NOTE_MAX_MS);
  const left = VOICE_NOTE_MAX_MS - shown;
  return {
    label: formatClock(shown),
    secondsLeft: left <= VOICE_NOTE_COUNTDOWN_MS ? Math.ceil(left / 1000) : null,
    reachedCap: elapsedMs >= VOICE_NOTE_MAX_MS,
  };
}

/**
 * A note's total length: the file's own when the browser knows it, else the length recorded with it. A webm fresh from
 * MediaRecorder carries no length, so Chrome says Infinity for it; that is what made the old player's clock run on.
 */
export function voiceTotalMs(elementDurationSec: number | null | undefined, knownMs: number | null | undefined): number | null {
  if (typeof elementDurationSec === 'number' && Number.isFinite(elementDurationSec) && elementDurationSec > 0) {
    return Math.round(elementDurationSec * 1000);
  }
  return typeof knownMs === 'number' && Number.isFinite(knownMs) && knownMs > 0 ? knownMs : null;
}

/** The length a sent note was stored with (Cloudinary's, in seconds), or null. */
export function knownDurationMs(meta: { durationSec?: number } | null | undefined): number | null {
  const sec = meta?.durationSec;
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
}

/** The player: elapsed / total, progress 0..1, both held at the total; overran says the player should stop it there. */
export function playbackClock(currentSec: number, totalMs: number | null): {
  label: string; elapsedMs: number; progress: number; overran: boolean;
} {
  const raw = Number.isFinite(currentSec) && currentSec > 0 ? currentSec * 1000 : 0;
  if (totalMs === null) return { label: formatClock(raw), elapsedMs: Math.round(raw), progress: 0, overran: false };
  const elapsedMs = Math.round(Math.min(raw, totalMs));
  return {
    label: `${formatClock(elapsedMs)} / ${formatClock(totalMs)}`,
    elapsedMs,
    progress: totalMs > 0 ? elapsedMs / totalMs : 0,
    overran: raw > totalMs + OVERRUN_GRACE_MS,
  };
}

/**
 * Longer than an upload accepts: possible only when the browser held the recorder's timers (an iPhone locked or a tab
 * in the background mid-recording), so the cap's stop came late. Sending would fail every time: it is said instead.
 */
export function isOverCap(durationMs: number): boolean {
  return durationMs > VOICE_NOTE_UPLOAD_LIMIT_MS;
}

/** Why the microphone could not be used, in the member's words. */
export function micErrorSentence(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "REASON can't use your microphone. Allow it in your browser's settings for this site, then try again.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError') return 'Your microphone is busy in another app. Close it there and try again.';
  return "Recording couldn't start. Please try again.";
}
