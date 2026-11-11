// What is written in a one-to-one message box and not yet sent: the typed text and a stopped voice note (Shirley
// Palmer, 11 Nov 2026, RSN 01). Each is kept against the exact conversation AND the recipient it was written for, under
// the signed-in member, so it can only ever come back in that conversation: opening another one shows its own box.
//
// Ephemeral client state (Zustand, CLAUDE.md §4): it lives in this tab's memory only. A second tab has its own; a
// reload or a closed tab drops it, after the page has asked (useLeaveGuard), since a recording is never written to the
// device's storage. A picked picture is not kept here: it stays in the box it was picked in and is dropped when another
// conversation opens.

import { create } from 'zustand';

export interface VoiceDraft {
  toUserId: string;
  blob: Blob;
  durationMs: number;
  /** True from the moment Send is pressed until the server answers: no second send, from this box or a remounted one. */
  sending: boolean;
}

interface ComposerDraft {
  toUserId: string;
  text: string;
  voice: VoiceDraft | null;
}

interface DraftsState {
  drafts: Record<string, ComposerDraft>;
}

export const useComposerDrafts = create<DraftsState>(() => ({ drafts: {} }));

/** The box's key: who is signed in, and the conversation (or the person a first message is being written to). */
export function threadKeyOf(myUserId: string, place: { conversationId?: string | null; toUserId?: string | null }): string | null {
  if (place.conversationId) return `${myUserId}:dm:${place.conversationId}`;
  if (place.toUserId) return `${myUserId}:new:${place.toUserId}`;
  return null;
}

/** A draft for this key, only when it was written for this recipient. */
function draftFor(state: DraftsState, key: string, toUserId: string): ComposerDraft | null {
  const d = state.drafts[key];
  return d && d.toUserId === toUserId ? d : null;
}

function write(key: string, toUserId: string, change: (d: ComposerDraft) => ComposerDraft): void {
  useComposerDrafts.setState((s) => {
    const current = draftFor(s, key, toUserId) ?? { toUserId, text: '', voice: null };
    const next = change(current);
    const drafts = { ...s.drafts };
    if (!next.text && !next.voice) delete drafts[key];
    else drafts[key] = next;
    return { drafts };
  });
}

export function textDraftOf(state: DraftsState, key: string, toUserId: string): string {
  return draftFor(state, key, toUserId)?.text ?? '';
}

export function setTextDraft(key: string, toUserId: string, text: string): void {
  write(key, toUserId, (d) => ({ ...d, text }));
}

/** After a text is sent: empty the box, unless more was typed meanwhile (that stays). */
export function clearTextDraftIf(key: string, toUserId: string, sent: string): void {
  write(key, toUserId, (d) => (d.text.trim() === sent.trim() ? { ...d, text: '' } : d));
}

export function voiceDraftOf(state: DraftsState, key: string, toUserId: string): VoiceDraft | null {
  return draftFor(state, key, toUserId)?.voice ?? null;
}

export function keepVoiceDraft(key: string, toUserId: string, blob: Blob, durationMs: number): void {
  write(key, toUserId, (d) => ({ ...d, voice: { toUserId, blob, durationMs, sending: false } }));
}

/**
 * Press Send: takes the note and marks it sending, in one synchronous step. A second press (a double click, or the
 * same conversation's box mounted again mid-upload) finds it already sending and gets null, so one note is one message.
 */
export function claimVoiceSend(key: string, toUserId: string): VoiceDraft | null {
  const voice = voiceDraftOf(useComposerDrafts.getState(), key, toUserId);
  if (!voice || voice.sending) return null;
  write(key, toUserId, (d) => ({ ...d, voice: d.voice ? { ...d.voice, sending: true } : null }));
  return voice;
}

/** The send failed: the note is back, unsent, for another try. */
export function releaseVoiceSend(key: string): void {
  useComposerDrafts.setState((s) => {
    const d = s.drafts[key];
    if (!d?.voice) return s;
    return { drafts: { ...s.drafts, [key]: { ...d, voice: { ...d.voice, sending: false } } } };
  });
}

/** Sent, or discarded: gone from its conversation. */
export function discardVoiceDraft(key: string): void {
  useComposerDrafts.setState((s) => {
    const d = s.drafts[key];
    if (!d) return s;
    const drafts = { ...s.drafts };
    if (d.text) drafts[key] = { ...d, voice: null };
    else delete drafts[key];
    return { drafts };
  });
}

/** Any voice note in this tab not yet sent: the page asks before it is closed or reloaded. */
export function anyUnsentVoice(state: DraftsState): boolean {
  return Object.values(state.drafts).some((d) => !!d.voice);
}

/**
 * A first message to someone made the conversation (or one turned out to exist already): whatever is still unsent in
 * the new-message box moves to that conversation's box, for the same person only, never over a draft already there.
 */
export function moveNewMessageDrafts(myUserId: string, toUserId: string, conversationId: string): void {
  const from = threadKeyOf(myUserId, { toUserId });
  const to = threadKeyOf(myUserId, { conversationId });
  if (!from || !to) return;
  useComposerDrafts.setState((s) => {
    const d = s.drafts[from];
    if (!d || d.toUserId !== toUserId || s.drafts[to]) return s;
    const drafts = { ...s.drafts, [to]: d };
    delete drafts[from];
    return { drafts };
  });
}
