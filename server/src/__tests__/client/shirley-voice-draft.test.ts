// server/src/__tests__/client/shirley-voice-draft.test.ts
// Shirley Palmer's walkthrough (11 Nov 2026, brief items RSN 01 P0, RSN 05 and RSN 06 P1): a voice note recorded to
// one person and stopped without sending was still in the message box when she opened another person, one tap from
// reaching the wrong person. Root cause: /messages/:conversationId, /messages/new/:userId and /messages/g/:groupId all
// render the same <MessagesPage />, so React kept ONE page instance across conversations, and the recording, the
// stopped note, the typed text and a picked picture were plain page state never tied to a conversation; Send posted
// whatever was pending to whoever was open.
//
// Now the box is its own component (DmComposer) mounted with key={threadKey}: opening another conversation gives a
// fresh box. What is unsent is kept in composer-drafts, keyed by the signed-in member, the conversation and the
// recipient, so it can only ever come back in the conversation it was written in. The recorder (voice-recorder.ts)
// is plain TypeScript run here against a fake microphone; the box and the player are drawn here; the wiring is pinned
// by its source. The two-member browser run is e2e/tests/shirley-voice-draft.spec.ts.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as drafts from '../../../../client/src/features/messages/voice/composer-drafts';
import {
  claimVoiceSend, discardVoiceDraft, keepVoiceDraft, releaseVoiceSend, setTextDraft, textDraftOf,
  threadKeyOf, useComposerDrafts, voiceDraftOf, anyUnsentVoice, claimTextSend, endTextSend, textSendingOf, dropVoiceById,
  dropDraftsTo, clearComposerDrafts, moveNewMessageDrafts,
} from '../../../../client/src/features/messages/voice/composer-drafts';
import {
  VOICE_NOTE_MAX_MS, VOICE_NOTE_COUNTDOWN_MS, VOICE_NOTE_UPLOAD_LIMIT_MS, VOICE_COPY, formatClock, recordingClock,
  playbackClock, voiceTotalMs, knownDurationMs, isOverCap, micErrorSentence,
} from '../../../../client/src/features/messages/voice/voice-note';
import { createVoiceRecorder, pickRecordingType, type MediaRecorderLike, type RecorderDeps, type StreamLike } from '../../../../client/src/features/messages/voice/voice-recorder';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const ME = 'me-0001';
const A = 'user-a';
const B = 'user-b';
const KEY_A = threadKeyOf(ME, { conversationId: 'conv-a' })!;
const KEY_B = threadKeyOf(ME, { conversationId: 'conv-b' })!;
const blob = (bytes = 10) => new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });

beforeEach(() => useComposerDrafts.setState({ drafts: {}, epoch: 0 }));

// ─── RSN 01: a draft belongs to one conversation and one recipient ───────────────────────────────────────────────────

describe('drafts are keyed by the member, the conversation and the recipient', () => {
  it('a conversation, a new message to someone, and nothing: three different keys, each carrying who is signed in', () => {
    expect(threadKeyOf(ME, { conversationId: 'conv-a' })).toBe('me-0001:dm:conv-a');
    expect(threadKeyOf(ME, { conversationId: null, toUserId: A })).toBe('me-0001:new:user-a');
    expect(threadKeyOf(ME, {})).toBeNull();
    expect(threadKeyOf('someone-else', { conversationId: 'conv-a' })).not.toBe(KEY_A);
  });

  it('a voice note stopped in the chat with A is there in A, and never in B', () => {
    keepVoiceDraft(KEY_A, A, blob(), 12_000);
    const state = useComposerDrafts.getState();
    expect(voiceDraftOf(state, KEY_A, A)).toMatchObject({ toUserId: A, durationMs: 12_000, sending: false });
    expect(voiceDraftOf(state, KEY_B, B)).toBeNull();
  });

  it('a draft whose recipient is not the one this conversation is with is not given out (defence in depth)', () => {
    keepVoiceDraft(KEY_A, A, blob(), 12_000);
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, B)).toBeNull();
    expect(claimVoiceSend(KEY_A, B)).toBeNull();
  });

  it('typed text stays with its conversation too: B never shows what was typed to A', () => {
    setTextDraft(KEY_A, A, 'meet Tuesday?');
    const state = useComposerDrafts.getState();
    expect(textDraftOf(state, KEY_A, A)).toBe('meet Tuesday?');
    expect(textDraftOf(state, KEY_B, B)).toBe('');
    expect(textDraftOf(state, KEY_A, B)).toBe('');
  });

  it('a sent text clears the box only when it still holds what was sent (more typed meanwhile stays)', () => {
    setTextDraft(KEY_A, A, 'hello');
    endTextSend(claimTextSend(KEY_A, A)!, 'hello', true);
    expect(textDraftOf(useComposerDrafts.getState(), KEY_A, A)).toBe('');
    setTextDraft(KEY_A, A, 'hello');
    const token = claimTextSend(KEY_A, A)!;
    setTextDraft(KEY_A, A, 'hello again');
    endTextSend(token, 'hello', true);
    expect(textDraftOf(useComposerDrafts.getState(), KEY_A, A)).toBe('hello again');
  });

  it('a text on its way is sent once: a second press, or the box mounted again mid-send, gets nothing (Minor 8)', () => {
    setTextDraft(KEY_A, A, 'see you at ten');
    const first = claimTextSend(KEY_A, A);
    expect(first).not.toBeNull();
    expect(claimTextSend(KEY_A, A)).toBeNull();
    expect(textSendingOf(useComposerDrafts.getState(), KEY_A, A)).toBe(true);
    expect(textSendingOf(useComposerDrafts.getState(), KEY_B, B)).toBe(false);
    endTextSend(first!, 'see you at ten', false);
    expect(textSendingOf(useComposerDrafts.getState(), KEY_A, A)).toBe(false);
    expect(textDraftOf(useComposerDrafts.getState(), KEY_A, A)).toBe('see you at ten');
    expect(claimTextSend(KEY_A, A)).not.toBeNull();
  });

  it('a first message to someone made the conversation: what is unsent in the new-message box moves there, for that person only', () => {
    const fresh = threadKeyOf(ME, { toUserId: A })!;
    keepVoiceDraft(fresh, A, blob(), 8_000);
    setTextDraft(fresh, A, 'and also');
    drafts.moveNewMessageDrafts(ME, A, 'conv-a');
    const state = useComposerDrafts.getState();
    expect(voiceDraftOf(state, KEY_A, A)?.durationMs).toBe(8_000);
    expect(textDraftOf(state, KEY_A, A)).toBe('and also');
    expect(voiceDraftOf(state, fresh, A)).toBeNull();
    expect(voiceDraftOf(state, KEY_B, B)).toBeNull();
  });

  it('a move never overwrites a draft already in the conversation, and never moves another person\'s draft', () => {
    keepVoiceDraft(KEY_A, A, blob(), 2_000);
    keepVoiceDraft(threadKeyOf(ME, { toUserId: A })!, A, blob(), 9_000);
    drafts.moveNewMessageDrafts(ME, A, 'conv-a');
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)?.durationMs).toBe(2_000);
    useComposerDrafts.setState({ drafts: {} });
    keepVoiceDraft(threadKeyOf(ME, { toUserId: B })!, B, blob(), 4_000);
    drafts.moveNewMessageDrafts(ME, A, 'conv-x');
    expect(voiceDraftOf(useComposerDrafts.getState(), threadKeyOf(ME, { conversationId: 'conv-x' })!, A)).toBeNull();
  });

  it('the app knows when the signed-in member has a voice note unsent, to ask before the tab is closed or reloaded', () => {
    expect(anyUnsentVoice(useComposerDrafts.getState(), ME)).toBe(false);
    keepVoiceDraft(KEY_A, A, blob(), 4_000);
    expect(anyUnsentVoice(useComposerDrafts.getState(), ME)).toBe(true);
    discardVoiceDraft(KEY_A);
    expect(anyUnsentVoice(useComposerDrafts.getState(), ME)).toBe(false);
  });

  it('only the signed-in member\'s notes count; with nobody signed in, none (I1)', () => {
    keepVoiceDraft(threadKeyOf('someone-else', { conversationId: 'conv-z' })!, A, blob(), 4_000);
    expect(anyUnsentVoice(useComposerDrafts.getState(), ME)).toBe(false);
    expect(anyUnsentVoice(useComposerDrafts.getState(), null)).toBe(false);
    expect(anyUnsentVoice(useComposerDrafts.getState(), 'someone-else')).toBe(true);
  });

  it('signing out, a blocked session, or another member signing in empties every draft, and boxes opened before write nothing more (I1)', () => {
    // The real query cache: its member-change moments are where the drafts are emptied.
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded here, after the store, as the app loads it
    const cache = require('../../../../client/src/lib/queryClient') as typeof import('../../../../client/src/lib/queryClient');
    keepVoiceDraft(KEY_A, A, blob(), 4_000);
    setTextDraft(KEY_B, B, 'private words');
    cache.clearCache();
    expect(useComposerDrafts.getState().drafts).toEqual({});
    expect(useComposerDrafts.getState().epoch).toBe(1);
    keepVoiceDraft(KEY_A, A, blob(), 4_000);
    cache.setCacheOwner('first-member');
    cache.setCacheOwner('first-member');
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)).not.toBeNull();
    cache.setCacheOwner('second-member');
    expect(useComposerDrafts.getState().drafts).toEqual({});
    clearComposerDrafts();
    expect(useComposerDrafts.getState().epoch).toBe(3);
  });

  it('nothing written to someone who can no longer get messages (blocked, conversation deleted, former member) is kept (Minor 2)', () => {
    keepVoiceDraft(KEY_A, A, blob(), 4_000);
    setTextDraft(threadKeyOf(ME, { toUserId: A })!, A, 'hello');
    keepVoiceDraft(KEY_B, B, blob(), 4_000);
    dropDraftsTo(A);
    const state = useComposerDrafts.getState();
    expect(voiceDraftOf(state, KEY_A, A)).toBeNull();
    expect(textDraftOf(state, threadKeyOf(ME, { toUserId: A })!, A)).toBe('');
    expect(voiceDraftOf(state, KEY_B, B)).not.toBeNull();
  });

  it('a note sending from a new-message box that becomes the conversation mid-upload is cleared, or released, where it is now (Minor 1)', () => {
    const fresh = threadKeyOf(ME, { toUserId: A })!;
    keepVoiceDraft(fresh, A, blob(), 6_000);
    const sending = claimVoiceSend(fresh, A)!;
    moveNewMessageDrafts(ME, A, 'conv-a');
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)?.sending).toBe(true);
    releaseVoiceSend(sending.id);
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)?.sending).toBe(false);
    const again = claimVoiceSend(KEY_A, A)!;
    dropVoiceById(again.id);
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)).toBeNull();
    expect(anyUnsentVoice(useComposerDrafts.getState(), ME)).toBe(false);
  });

  it('a text sending from a new-message box that becomes the conversation mid-send is ended where it is now (Minor 1)', () => {
    const fresh = threadKeyOf(ME, { toUserId: A })!;
    setTextDraft(fresh, A, 'first words');
    const token = claimTextSend(fresh, A)!;
    moveNewMessageDrafts(ME, A, 'conv-a');
    expect(textSendingOf(useComposerDrafts.getState(), KEY_A, A)).toBe(true);
    endTextSend(token, 'first words', true);
    expect(textSendingOf(useComposerDrafts.getState(), KEY_A, A)).toBe(false);
    expect(textDraftOf(useComposerDrafts.getState(), KEY_A, A)).toBe('');
  });
});

describe('one send per note, however many taps (RSN 05, double click)', () => {
  it('the first claim takes the note; a second tap while it is sending gets nothing', () => {
    keepVoiceDraft(KEY_A, A, blob(), 5_000);
    const first = claimVoiceSend(KEY_A, A);
    const second = claimVoiceSend(KEY_A, A);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)?.sending).toBe(true);
  });

  it('a failed send gives the note back, unsent, for another try; a sent one is gone', () => {
    keepVoiceDraft(KEY_A, A, blob(), 5_000);
    const claimed = claimVoiceSend(KEY_A, A)!;
    releaseVoiceSend(claimed.id);
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)?.sending).toBe(false);
    expect(claimVoiceSend(KEY_A, A)).not.toBeNull();
    discardVoiceDraft(KEY_A);
    expect(voiceDraftOf(useComposerDrafts.getState(), KEY_A, A)).toBeNull();
  });

  it('a note with nothing in it cannot be claimed', () => {
    expect(claimVoiceSend(KEY_A, A)).toBeNull();
  });
});

// ─── RSN 06: the 60 second cap, the countdown, and a timer that stops at the real length ─────────────────────────────

describe('the recording cap is one constant: 60 seconds, a countdown in the last 10', () => {
  it('the cap and the countdown', () => {
    expect(VOICE_NOTE_MAX_MS).toBe(60_000);
    expect(VOICE_NOTE_COUNTDOWN_MS).toBe(10_000);
  });

  it('no countdown before the last ten seconds; then whole seconds left; the cap is reached at 60 s', () => {
    expect(recordingClock(0)).toEqual({ label: '0:00', secondsLeft: null, reachedCap: false });
    expect(recordingClock(49_999).secondsLeft).toBeNull();
    expect(recordingClock(50_000).secondsLeft).toBe(10);
    expect(recordingClock(55_400).secondsLeft).toBe(5);
    expect(recordingClock(59_950).secondsLeft).toBe(1);
    expect(recordingClock(60_000)).toEqual({ label: '1:00', secondsLeft: 0, reachedCap: true });
  });

  it('the clock never shows more than the cap, even when the stop lands a moment late', () => {
    expect(recordingClock(61_500).label).toBe('1:00');
  });

  it('the upload check allows the stop\'s moment of lag past the cap and no more', () => {
    const lib = readClientSource('lib/cloudinary.ts');
    expect(VOICE_NOTE_UPLOAD_LIMIT_MS).toBe(65_000);
    expect(lib).toMatch(/import \{ VOICE_COPY, VOICE_NOTE_UPLOAD_LIMIT_MS \} from '@\/features\/messages\/voice\/voice-note';/);
    expect(lib).toMatch(/export const MAX_AUDIO_DURATION_MS = VOICE_NOTE_UPLOAD_LIMIT_MS;/);
    expect(lib).toMatch(/message: VOICE_COPY\.tooLong/);
    // The server has no duration check of its own (controller ruling): said where the cap is enforced.
    expect(lib).toMatch(/The server has no duration check of its own/);
    expect(readClientSource('features/messages/voice/voice-note.ts')).toMatch(/so it has no duration check of its own/);
  });

  it('a note longer than an upload accepts (timers held on a locked phone) says so, never "try again" (Minor 7)', () => {
    expect(VOICE_COPY.tooLong).toBe('This voice note is longer than 60 seconds. Record a shorter one.');
    expect(isOverCap(65_000)).toBe(false);
    expect(isOverCap(65_001)).toBe(true);
  });
});

describe('playback shows total length, elapsed time and progress, and stops at the real length', () => {
  it('clock format', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9_999)).toBe('0:09');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('the total is the file\'s own length when the browser knows it, else the recorded length (a fresh webm says Infinity)', () => {
    expect(voiceTotalMs(12.4, 12_000)).toBe(12_400);
    expect(voiceTotalMs(Number.POSITIVE_INFINITY, 12_000)).toBe(12_000);
    expect(voiceTotalMs(Number.NaN, 12_000)).toBe(12_000);
    expect(voiceTotalMs(undefined, null)).toBeNull();
    expect(knownDurationMs({ durationSec: 7.5 })).toBe(7_500);
    expect(knownDurationMs({})).toBeNull();
    expect(knownDurationMs(null)).toBeNull();
  });

  it('elapsed and progress never pass the total; the label is elapsed / total', () => {
    expect(playbackClock(3, 10_000)).toEqual({ label: '0:03 / 0:10', elapsedMs: 3_000, progress: 0.3, overran: false });
    const late = playbackClock(14, 10_000);
    expect(late.elapsedMs).toBe(10_000);
    expect(late.progress).toBe(1);
    expect(late.label).toBe('0:10 / 0:10');
    expect(late.overran).toBe(true);
  });

  it('a moment past the end (the browser\'s last tick) is not an overrun; with no total known, elapsed alone', () => {
    expect(playbackClock(10.2, 10_000).overran).toBe(false);
    expect(playbackClock(4, null)).toEqual({ label: '0:04', elapsedMs: 4_000, progress: 0, overran: false });
  });
});

describe('words', () => {
  it('Send is said in words, and so is the note\'s state', () => {
    expect(VOICE_COPY.send).toBe('Send voice note');
    expect(VOICE_COPY.notSent).toBe('Not sent');
    expect(VOICE_COPY.sent).toBe('Sent');
    expect(VOICE_COPY.discard).toBe('Discard');
  });

  it('discarding always asks first, whatever the length (CLAUDE.md §12, controller ruling)', () => {
    const box = readClientSource('features/messages/DmComposer.tsx');
    const discard = box.slice(box.indexOf('const discardVoice = async'), box.indexOf('const pickImage'));
    expect(discard).toMatch(/const yes = await ask\(\{ title: VOICE_COPY\.discardTitle/);
    expect(discard).not.toMatch(/durationMs/);
  });

  it('a microphone problem is said in plain words, never an error name', () => {
    const named = (name: string) => Object.assign(new Error('x'), { name });
    expect(micErrorSentence(named('NotAllowedError'))).toMatch(/allow it/i);
    expect(micErrorSentence(named('SecurityError'))).toMatch(/allow it/i);
    expect(micErrorSentence(named('NotFoundError'))).toMatch(/No microphone/);
    expect(micErrorSentence(named('NotReadableError'))).toMatch(/busy/);
    expect(micErrorSentence(new Error('boom'))).toBe("Recording couldn't start. Please try again.");
    for (const n of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Other']) {
      expect(micErrorSentence(named(n))).not.toMatch(/Error|undefined/);
    }
  });
});

// ─── The recorder, run against a fake microphone and a fake clock ────────────────────────────────────────────────────

class FakeRecorder implements MediaRecorderLike {
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  starts = 0;
  start() { this.state = 'recording'; this.starts += 1; }
  requestData() { this.ondataavailable?.({ data: blob(50) }); }
  stop() {
    if (this.state !== 'recording') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: blob(50) });
    this.onstop?.();
  }
}

function rig(opts: { deny?: string; slowMic?: boolean } = {}) {
  let now = 1_000_000;
  const intervals = new Map<number, () => void>();
  const timeouts: Array<() => void> = [];
  let id = 0;
  const tracks = { stopped: 0 };
  const recorders: FakeRecorder[] = [];
  let grant: (() => void) | null = null;
  const stream: StreamLike = { getTracks: () => [{ stop: () => { tracks.stopped += 1; } }] };
  const deps: RecorderDeps = {
    supported: () => true,
    getUserMedia: () => {
      if (opts.deny) return Promise.reject(Object.assign(new Error('denied'), { name: opts.deny }));
      if (opts.slowMic) return new Promise<StreamLike>((resolve) => { grant = () => resolve(stream); });
      return Promise.resolve(stream);
    },
    createRecorder: () => { const r = new FakeRecorder(); recorders.push(r); return r; },
    now: () => now,
    setInterval: (fn) => { id += 1; intervals.set(id, fn); return id; },
    clearInterval: (i) => { intervals.delete(i); },
    setTimeout: (fn) => { timeouts.push(fn); },
  };
  const seen = {
    states: [] as string[], ticks: [] as number[], recorded: [] as Array<{ durationMs: number; how: string; size: number }>,
    errors: [] as string[],
  };
  const rec = createVoiceRecorder(deps, {
    onState: (s) => seen.states.push(s),
    onTick: (ms) => seen.ticks.push(ms),
    onRecorded: (b, durationMs, how) => seen.recorded.push({ durationMs, how, size: b.size }),
    onError: (s) => seen.errors.push(s),
  });
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) { now = Math.min(end, now + 100); for (const fn of [...intervals.values()]) fn(); }
  };
  const flushTimeouts = () => { while (timeouts.length) timeouts.shift()!(); };
  return { rec, seen, advance, flushTimeouts, tracks, recorders, intervals, grant: () => grant?.() };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('the recorder', () => {
  it('Record, Stop: the take is handed over once, with its length, and the microphone is released', async () => {
    const t = rig();
    await t.rec.start();
    expect(t.rec.state()).toBe('recording');
    t.advance(4_000);
    t.rec.stop();
    t.flushTimeouts();
    expect(t.seen.recorded).toHaveLength(1);
    expect(t.seen.recorded[0].how).toBe('stopped');
    expect(t.seen.recorded[0].durationMs).toBe(4_000);
    expect(t.tracks.stopped).toBe(1);
    expect(t.rec.state()).toBe('idle');
    expect(t.intervals.size).toBe(0);
  });

  it('stops by itself at 60 seconds, and the clock it reports never passes 60 s', async () => {
    const t = rig();
    await t.rec.start();
    t.advance(VOICE_NOTE_MAX_MS + 2_000);
    t.flushTimeouts();
    expect(t.seen.recorded).toHaveLength(1);
    expect(t.seen.recorded[0].how).toBe('cap');
    expect(Math.max(...t.seen.ticks)).toBeLessThanOrEqual(VOICE_NOTE_MAX_MS);
    expect(t.seen.recorded[0].durationMs).toBeLessThanOrEqual(VOICE_NOTE_MAX_MS + 5_000);
  });

  it('Cancel hands nothing over', async () => {
    const t = rig();
    await t.rec.start();
    t.advance(3_000);
    t.rec.cancel();
    t.flushTimeouts();
    expect(t.seen.recorded).toHaveLength(0);
    expect(t.tracks.stopped).toBe(1);
    expect(t.rec.state()).toBe('idle');
  });

  it('leaving the conversation while recording stops the take and hands it to the conversation it was recorded in', async () => {
    const t = rig();
    await t.rec.start();
    t.advance(6_000);
    t.rec.dispose();
    t.flushTimeouts();
    expect(t.seen.recorded).toEqual([expect.objectContaining({ how: 'left', durationMs: 6_000 })]);
  });

  it('leaving while the browser is still asking for the microphone: no recording starts, the microphone is released', async () => {
    const t = rig({ slowMic: true });
    const started = t.rec.start();
    expect(t.rec.state()).toBe('starting');
    t.rec.dispose();
    t.grant();
    await started;
    await settle();
    expect(t.recorders.every((r) => r.starts === 0)).toBe(true);
    expect(t.tracks.stopped).toBe(1);
    expect(t.seen.recorded).toHaveLength(0);
  });

  it('a second Record while one is starting or running does nothing', async () => {
    const t = rig();
    const first = t.rec.start();
    const second = t.rec.start();
    await Promise.all([first, second]);
    expect(t.recorders).toHaveLength(1);
  });

  it('a refused microphone is said in words and leaves the recorder ready again', async () => {
    const t = rig({ deny: 'NotAllowedError' });
    await t.rec.start();
    expect(t.seen.errors).toHaveLength(1);
    expect(t.seen.errors[0]).toMatch(/allow it/i);
    expect(t.rec.state()).toBe('idle');
  });

  it('a browser with no recorder says so instead of failing silently', async () => {
    const t = rig();
    const deps = { supported: () => false } as unknown as RecorderDeps;
    const errors: string[] = [];
    const rec = createVoiceRecorder(deps, { onState: () => {}, onTick: () => {}, onRecorded: () => {}, onError: (s) => errors.push(s) });
    await rec.start();
    expect(errors).toEqual([VOICE_COPY.unsupported]);
    expect(t.seen.errors).toHaveLength(0);
  });

  it('a tap too short to hold any sound hands nothing over', async () => {
    const t = rig();
    await t.rec.start();
    t.advance(100);
    t.rec.stop();
    t.flushTimeouts();
    expect(t.seen.recorded).toHaveLength(0);
  });
});

// ─── The box, drawn: A's note never in B's box ───────────────────────────────────────────────────────────────────────

type ComposerProps = {
  myUserId: string; threadKey: string; conversationId?: string; toUserId: string; recipientName: string | null;
  replyTarget: null; onReplyDone: () => void; boxRef: { current: null }; onBoxFocus: () => void;
};

const mutateCalls: unknown[] = [];
function composer() {
  return loadClientModule('features/messages/DmComposer.tsx', {
    'lucide-react': iconStandIns,
    // The real store, read through its live state: a server render reads a zustand store's INITIAL state otherwise.
    './voice/composer-drafts': { ...drafts, useComposerDrafts: Object.assign(<T>(pick: (s: ReturnType<typeof useComposerDrafts.getState>) => T) => pick(useComposerDrafts.getState()), useComposerDrafts) },
    './thread/useSendMessage': {
      useSendMessage: () => ({ mutate: (v: unknown) => mutateCalls.push(v), isPending: false }),
    },
    '@/stores/toastStore': { useToastStore: (pick?: (s: { addToast: () => void }) => unknown) => (pick ? pick({ addToast: () => {} }) : { addToast: () => {} }) },
    '@/hooks/useConfirm': { useConfirm: () => ({ ask: async () => true, confirmDialog: null }) },
    '@/lib/cloudinary': {
      isCloudinaryConfigured: () => true, validateImageFile: () => null,
      uploadImageToCloudinary: async () => ({}), uploadAudioToCloudinary: async () => ({}),
    },
    '@/components/chat/EmojiPicker': { __esModule: true, default: () => null, pickInto: () => {} },
    '@/components/ui/Button': {
      Button: ({ children, isLoading: _l, ...rest }: { children?: ReactNode; isLoading?: boolean }) => createElement('button', rest, children),
    },
  }).default as (props: ComposerProps) => JSX.Element;
}
/** The opening tag of the button with this test id, whatever order its attributes come in. */
const buttonTag = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? '';
const draw = (key: string, toUserId: string) => renderToStaticMarkup(createElement(composer(), {
  myUserId: ME, threadKey: key, conversationId: key.split(':').pop(), toUserId, recipientName: 'Ana',
  replyTarget: null, onReplyDone: () => {}, boxRef: { current: null }, onBoxFocus: () => {},
}));

describe('the message box, drawn', () => {
  it('in A, a stopped note shows as Not sent, with a labelled Send voice note and Discard, and the text row steps aside', () => {
    keepVoiceDraft(KEY_A, A, blob(), 12_000);
    const html = draw(KEY_A, A);
    expect(html).toContain('data-testid="dm-voice-draft"');
    expect(html).toContain('Not sent');
    expect(html).toMatch(/<button[^>]*data-testid="dm-voice-send"[^>]*>[\s\S]*?Send voice note<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="dm-voice-discard"[^>]*>[\s\S]*?Discard<\/button>/);
    expect(html).toContain('0:00 / 0:12');
    expect(html).not.toContain('<textarea');
  });

  it('in B, with A\'s note kept, nothing of it shows: the normal box, empty, with its Send message button', () => {
    keepVoiceDraft(KEY_A, A, blob(), 12_000);
    setTextDraft(KEY_A, A, 'for Ana only');
    const html = draw(KEY_B, B);
    expect(html).not.toContain('dm-voice-draft');
    expect(html).not.toContain('Not sent');
    expect(html).not.toContain('Send voice note');
    expect(html).not.toContain('for Ana only');
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-label="Send message"');
  });

  it('in A\'s conversation but with another recipient (another account signed in), nothing of it shows', () => {
    keepVoiceDraft(KEY_A, A, blob(), 12_000);
    expect(draw(KEY_A, B)).not.toContain('dm-voice-draft');
  });

  it('while the note is sending: Sending, and the Send button cannot be pressed again', () => {
    keepVoiceDraft(KEY_A, A, blob(), 12_000);
    claimVoiceSend(KEY_A, A);
    const html = draw(KEY_A, A);
    expect(html).toContain('Sending');
    expect(buttonTag(html, 'dm-voice-send')).toContain('disabled=""');
    expect(html).not.toContain('Not sent');
  });

  it('the record button says what it does, and every control here is a 44px target', () => {
    const html = draw(KEY_B, B);
    expect(html).toContain('aria-label="Record a voice note"');
    keepVoiceDraft(KEY_A, A, blob(), 12_000);
    const card = draw(KEY_A, A);
    for (const id of ['dm-voice-send', 'dm-voice-discard']) expect(buttonTag(card, id)).toContain('min-h-[44px]');
    expect(buttonTag(card, 'dm-voice-send')).not.toContain('disabled=""');
  });
});

describe('the player, drawn', () => {
  const player = () => loadClientModule('features/messages/voice/VoiceNotePlayer.tsx', { 'lucide-react': iconStandIns }).default as
    (p: { src: string; durationMs: number | null; tone: 'own' | 'theirs' | 'draft'; testId?: string; status?: string }) => JSX.Element;
  const html = (p: Partial<{ durationMs: number | null; tone: 'own' | 'theirs' | 'draft'; status: string }> = {}) =>
    renderToStaticMarkup(createElement(player(), { src: 'https://res.cloudinary.com/x/v.webm', durationMs: 12_000, tone: 'theirs', ...p }));

  it('a received note shows its total length before it is played, and a progress bar up to that length', () => {
    const h = html();
    expect(h).toContain('0:00 / 0:12');
    expect(h).toContain('aria-label="Play voice note"');
    expect(h).toMatch(/role="progressbar"[^>]*aria-valuemax="12"/);
    expect(h).toContain('preload="metadata"');
  });

  it('a sent note says Sent', () => {
    expect(html({ tone: 'own', status: 'Sent' })).toContain('Sent');
  });

  it('the play button is a 44px target', () => {
    expect(html()).toMatch(/<button[^>]*class="[^"]*h-11 w-11/);
  });
});

// ─── The wiring, by source ───────────────────────────────────────────────────────────────────────────────────────────

describe('the page mounts one box per conversation', () => {
  const page = readClientSource('features/messages/MessagesPage.tsx');
  const box = readClientSource('features/messages/DmComposer.tsx');
  const send = readClientSource('features/messages/thread/useSendMessage.ts');

  it('the box is keyed by the conversation, so React never carries one conversation\'s box into another', () => {
    expect(page).toMatch(/<DmComposer\s+key=\{threadKey\}/);
    expect(page).toMatch(/const threadKey = threadKeyOf\(myUserId, \{ conversationId: activeId, toUserId: composeToUserId \}\);/);
  });

  it('no recording, voice note, picture or typed text is page state any more', () => {
    for (const gone of ['pendingAudio', 'recordingState', 'mediaRecorderRef', 'pendingImage', 'const [draft, setDraft]']) {
      expect(page).not.toContain(gone);
    }
  });

  it('the recipient is fixed when Send is pressed: the post goes to the person the note was recorded for', () => {
    expect(send).toMatch(/const to = vars\.toUserId \?\? toUserId;/);
    expect(send).toMatch(/toUserId: to,/);
    expect(box).toMatch(/claimVoiceSend\(threadKey, toUserId\)/);
    expect(box).toMatch(/toUserId: claimed\.toUserId/);
  });

  it('a voice note sent is cleared from its own conversation, by the key it was sent from, and says who it went to', () => {
    expect(box).toMatch(/dropVoiceById\(vars\.voiceId\)/);
    expect(box).toMatch(/releaseVoiceSend\(vars\.voiceId\)/);
    expect(box).toMatch(/endTextSend\(vars\.textToken, vars\.content, true\)/);
    expect(box).toMatch(/endTextSend\(vars\.textToken, vars\.content, false\)/);
    expect(box).toMatch(/VOICE_COPY\.sentTo\(/);
  });

  it('a take stopped by leaving is kept in the conversation it was recorded in, and the member is told', () => {
    expect(box).toMatch(/keepVoiceDraft\(threadKey, toUserId, b, durationMs\)/);
    expect(box).toMatch(/how === 'left'/);
  });

  it('closing or reloading the tab with a voice note unsent or recording asks first', () => {
    // In the app shell, so a reload from any page asks while the member has a note unsent (Minor 3).
    expect(readClientSource('features/reason/shell/ReasonShell.tsx')).toMatch(/useUnsentVoiceGuard\(user\?\.id\);/);
    expect(page).not.toMatch(/useLeaveGuard/);
    expect(box).toMatch(/useLeaveGuard\(recorder\.state !== 'idle'\)/);
    const guard = readClientSource('features/messages/voice/useLeaveGuard.ts');
    expect(guard).toMatch(/addEventListener\('beforeunload'/);
    expect(guard).toMatch(/removeEventListener\('beforeunload'/);
  });

  it('the recorder stops itself at the cap constant', () => {
    const rec = readClientSource('features/messages/voice/voice-recorder.ts');
    expect(rec).toMatch(/recordingClock\(elapsed\)\.reachedCap/);
    expect(rec).not.toMatch(/MAX_AUDIO_DURATION_MS/);
  });

  it('every voice note in the thread is drawn by the player, with its known length; the native control is gone', () => {
    expect(page).toMatch(/<VoiceNotePlayer[\s\S]{0,600}durationMs=\{knownDurationMs\(m\.attachmentMeta\)\}/);
    expect(page).not.toMatch(/<audio\b/);
    expect(box).not.toMatch(/<audio\b/);
  });

  it('the chat panel in the call room is keyed by its conversation too', () => {
    expect(readClientSource('features/messages/MeetPage.tsx')).toMatch(/<CallChatPanel\s+key=\{conversationId\}/);
  });
});

describe('fix round 1 (11 Nov 2026)', () => {
  const page = readClientSource('features/messages/MessagesPage.tsx');
  const box = readClientSource('features/messages/DmComposer.tsx');

  it('Cancel while the browser still asks for the microphone ends the attempt at once; a later grant only releases the mic (Minor 5)', async () => {
    let grant: ((s: StreamLike) => void) | null = null;
    let stopped = 0;
    let made = 0;
    const states: string[] = [];
    const rec = createVoiceRecorder({
      supported: () => true,
      getUserMedia: () => new Promise<StreamLike>((resolve) => { grant = resolve; }),
      createRecorder: () => { made += 1; return new FakeRecorder(); },
      now: () => 0, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {},
    }, { onState: (x) => states.push(x), onTick: () => {}, onRecorded: () => {}, onError: () => {} });
    const started = rec.start();
    expect(rec.state()).toBe('starting');
    rec.cancel();
    expect(rec.state()).toBe('idle');
    expect(states).toEqual(['starting', 'idle']);
    grant!({ getTracks: () => [{ stop: () => { stopped += 1; } }] });
    await started;
    expect(made).toBe(0);
    expect(stopped).toBe(1);
    expect(rec.state()).toBe('idle');
  });

  it('a Record pressed again after a cancelled ask records once, with the second grant', async () => {
    const grants: Array<(s: StreamLike) => void> = [];
    let made = 0;
    const rec = createVoiceRecorder({
      supported: () => true,
      getUserMedia: () => new Promise<StreamLike>((resolve) => { grants.push(resolve); }),
      createRecorder: () => { made += 1; return new FakeRecorder(); },
      now: () => 0, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => {},
    }, { onState: () => {}, onTick: () => {}, onRecorded: () => {}, onError: () => {} });
    const first = rec.start();
    rec.cancel();
    const second = rec.start();
    const mic = () => ({ getTracks: () => [{ stop: () => {} }] });
    grants[0](mic());
    grants[1](mic());
    await Promise.all([first, second]);
    expect(made).toBe(1);
    expect(rec.state()).toBe('recording');
  });

  it('iPhone: the recorder picks a format the browser can record, mp4 where webm is not supported', () => {
    expect(pickRecordingType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickRecordingType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecordingType(() => false)).toBe('');
    expect(pickRecordingType(undefined)).toBe('');
    expect(pickRecordingType(() => { throw new Error('old Safari'); })).toBe('');
    expect(readClientSource('features/messages/voice/useVoiceRecorder.ts')).toMatch(/pickRecordingType\(MediaRecorder\.isTypeSupported/);
    expect(readClientSource('lib/cloudinary.ts')).toMatch(/blob\.type\.includes\('mp4'\) \? 'mp4'/);
  });

  it('the reply quote is kept with its conversation and shown only there: no effect resets it a render late (Minor 6)', () => {
    expect(page).toMatch(/const \[reply, setReply\] = useState<\{ key: string; target: ReplyTarget \} \| null>\(null\);/);
    expect(page).toMatch(/const replyTarget = reply && reply\.key === threadKey \? reply\.target : null;/);
    expect(page).not.toMatch(/setReplyTarget\(null\); \}, \[activeId/);
  });

  it('blocking, deleting the conversation, or the other person leaving REASON drops what was written to them (Minor 2)', () => {
    expect(page).toMatch(/await api\.post\(`\/users\/\$\{userId\}\/block`, \{\}\);\s*dropDraftsTo\(userId\);/);
    expect(page).toMatch(/if \(partner\) dropDraftsTo\(partner\);/);
    expect(page).toMatch(/inboxData\?\.filter\(\(c\) => c\.otherIsFormerMember\)\.forEach\(\(c\) => dropDraftsTo\(c\.otherUserId\)\)/);
    expect(readClientSource('features/profile/PublicProfilePage.tsx')).toMatch(/if \(userId\) dropDraftsTo\(userId\);/);
    expect(readClientSource('components/ReportUserModal.tsx')).toMatch(/dropDraftsTo\(reportedId\);/);
  });

  it('a box opened for one member writes no take after the member changed; text and voice sends are claimed in the store', () => {
    expect(box).toMatch(/if \(!sameMember\(\)\) return;\s*keepVoiceDraft/);
    expect(box).toMatch(/const textToken = claimTextSend\(threadKey, toUserId\);\s*if \(textToken === null\) return;/);
    expect(box).toMatch(/busy=\{send\.isPending \|\| textSending\}/);
    expect(box).toMatch(/if \(voice && isOverCap\(voice\.durationMs\)\) \{ addToast\(VOICE_COPY\.tooLong, 'error'\); return; \}/);
  });

  it('an over-cap note says why on its card and its Send is off', () => {
    const fresh = threadKeyOf(ME, { conversationId: 'conv-long' })!;
    keepVoiceDraft(fresh, A, blob(), 80_000);
    const html = renderToStaticMarkup(createElement(composer(), {
      myUserId: ME, threadKey: fresh, conversationId: 'conv-long', toUserId: A, recipientName: 'Ana',
      replyTarget: null, onReplyDone: () => {}, boxRef: { current: null }, onBoxFocus: () => {},
    }));
    expect(html).toContain('This voice note is longer than 60 seconds. Record a shorter one.');
    expect(buttonTag(html, 'dm-voice-send')).toContain('disabled=""');
  });

  it('while a text from this conversation is on its way, its Send is off in a box mounted again', () => {
    setTextDraft(KEY_A, A, 'on its way');
    claimTextSend(KEY_A, A);
    const html = draw(KEY_A, A);
    expect(html).toMatch(/<button[^>]*aria-label="Send message"[^>]*>|<button[^>]*disabled=""[^>]*aria-label="Send message"/);
    const send = html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0] ?? '';
    expect(send).toContain('disabled=""');
  });
});
