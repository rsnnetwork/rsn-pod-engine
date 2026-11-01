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

// ─── Messages (30 Oct 2026 review, item 4.4, L8) ─────────────────────────────
//
// Stefan: "When a new message comes in, there is no sound." A short rising pair, unlike the timer's falling one, so the
// two are never mistaken for each other. Who plays it, and when not, is useMessageChime's business (one tab, not in the
// open conversation, not in a live event or a meeting); the setting is per device.

/** Two quick rising tones: "a message came in". Silent on failure. Tells the page it played (for its tests). */
export function playMessageChime(messageId?: string): void {
  try {
    const audio = getCtx();
    if (audio) {
      const now = audio.currentTime;
      tone(audio, 988, now, 0.09);
      tone(audio, 1319, now + 0.1, 0.16);
    }
  } catch {
    /* fail-open: a missed chime must never break the page */
  }
  window.dispatchEvent(new CustomEvent('reason:message-chime', { detail: { id: messageId ?? null } }));
}

/**
 * An incoming call (X3, 2 Nov 2026): the same rising pair three times over, so it reads as a ring and not a message.
 * Who plays it, and when not, is useMessageChime's business, under the same per-device setting. Silent on failure.
 */
export function playCallRing(ringId?: string): void {
  try {
    const audio = getCtx();
    if (audio) {
      const now = audio.currentTime;
      for (let i = 0; i < 3; i++) {
        tone(audio, 988, now + i * 0.5, 0.12);
        tone(audio, 1319, now + i * 0.5 + 0.14, 0.2);
      }
    }
  } catch {
    /* fail-open: a missed ring must never break the page */
  }
  window.dispatchEvent(new CustomEvent('reason:call-ring', { detail: { id: ringId ?? null } }));
}

/**
 * Browsers keep audio locked until the page is pressed or typed in; the first press of either readies it, so the first
 * message after that can sound. A message before any press stays silent: no page can change that. Returns the undo.
 */
export function readyAudioOnFirstPress(): () => void {
  const ready = () => {
    getCtx();
    stop();
  };
  const stop = () => {
    document.removeEventListener('pointerdown', ready, true);
    document.removeEventListener('keydown', ready, true);
  };
  document.addEventListener('pointerdown', ready, true);
  document.addEventListener('keydown', ready, true);
  return stop;
}

/** The setting "Sound for new messages and calls", kept on this device (as volume is), on until it is switched off. */
const MESSAGE_SOUND_KEY = 'reason:message-sound';

export function messageSoundOn(): boolean {
  try {
    return localStorage.getItem(MESSAGE_SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setMessageSoundOn(on: boolean): void {
  try {
    localStorage.setItem(MESSAGE_SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* a device that keeps nothing keeps the default: on */
  }
}
