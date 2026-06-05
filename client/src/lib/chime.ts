// WS3/B2 (27 May remaining work) — soft two-tone chime for timer warnings.
// WebAudio oscillator: no asset to load, ~0 bytes, and it degrades to
// silence (fail-open) when the browser blocks audio (no prior gesture,
// muted tab, missing AudioContext). Users in a live event have always
// interacted (camera prompt / join click), so the context is resumable.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

function tone(audio: AudioContext, freq: number, startAt: number, durationS: number): void {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Gentle envelope — a notification chime, not an alarm.
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.12, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
  osc.connect(gain).connect(audio.destination);
  osc.start(startAt);
  osc.stop(startAt + durationS);
}

/** Two descending soft tones — "time is wrapping up". Silent on failure. */
export function playTimerChime(): void {
  try {
    const audio = getCtx();
    if (!audio) return;
    const now = audio.currentTime;
    tone(audio, 880, now, 0.18);
    tone(audio, 660, now + 0.2, 0.24);
  } catch {
    /* fail-open: a missed chime must never break the room UI */
  }
}
