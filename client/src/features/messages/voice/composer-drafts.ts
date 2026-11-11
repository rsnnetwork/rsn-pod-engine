// What is written in a one-to-one message box and not yet sent: the typed text and a stopped voice note (Shirley
// Palmer, 11 Nov 2026, RSN 01). Each is kept against the exact conversation AND the recipient it was written for, under
// the signed-in member, so it can only ever come back in that conversation: opening another one shows its own box.
//
// Ephemeral client state (Zustand, CLAUDE.md §4): it lives in this tab's memory only. A second tab has its own; a
// reload or a closed tab drops it, after the page has asked (useUnsentVoiceGuard), since a recording is never written
// to the device's storage. A picked picture is not kept here: it stays in the box it was picked in and is dropped when
// another conversation opens. Everything here is emptied whenever the signed-in member changes (sign-out, a blocked
// session, another member signing in): the query cache's member-change hook, below.

import { create } from 'zustand';
import { onMemberChange } from '../../../lib/queryClient';

export interface VoiceDraft {
  /** This note, wherever its draft is kept: a send clears or releases THIS note, even after it moved to another key. */
  id: number;
  toUserId: string;
  blob: Blob;
  durationMs: number;
  /** True from the moment Send is pressed until the server answers: no second send, from this box or a remounted one. */
  sending: boolean;
}

interface ComposerDraft {
  toUserId: string;
  text: string;
  /**
   * The send under way of a text (with or without a picture), by its number, or null: no second send of it, from this
   * box or a remounted one; its answer ends THIS send, even after the draft moved to another key.
   */
  textSending: number | null;
  voice: VoiceDraft | null;
}

interface DraftsState {
  drafts: Record<string, ComposerDraft>;
  /** Bumped when the member changes: a box mounted before then writes nothing any more (a take stopped by sign-out). */
  epoch: number;
}

export const useComposerDrafts = create<DraftsState>(() => ({ drafts: {}, epoch: 0 }));

let nextVoiceId = 1;
let nextTextSend = 1;

/** The box's key: who is signed in, and the conversation (or the person a first message is being written to). */
export function threadKeyOf(
  myUserId: string | null | undefined,
  place: { conversationId?: string | null; toUserId?: string | null },
): string | null {
  if (!myUserId) return null;
  if (place.conversationId) return `${myUserId}:dm:${place.conversationId}`;
  if (place.toUserId) return `${myUserId}:new:${place.toUserId}`;
  return null;
}

/** A draft for this key, only when it was written for this recipient. */
function draftFor(state: DraftsState, key: string, toUserId: string): ComposerDraft | null {
  const d = state.drafts[key];
  return d && d.toUserId === toUserId ? d : null;
}

const isEmpty = (d: ComposerDraft) => !d.text && !d.voice && d.textSending === null;

function write(key: string, toUserId: string, change: (d: ComposerDraft) => ComposerDraft): void {
  useComposerDrafts.setState((s) => {
    const current = draftFor(s, key, toUserId) ?? { toUserId, text: '', textSending: null, voice: null };
    const next = change(current);
    const drafts = { ...s.drafts };
    if (isEmpty(next)) delete drafts[key];
    else drafts[key] = next;
    return { drafts };
  });
}

/** Change the voice note with this id, wherever it is kept. */
function writeVoiceById(id: number, change: (v: VoiceDraft) => VoiceDraft | null): void {
  useComposerDrafts.setState((s) => {
    const key = Object.keys(s.drafts).find((k) => s.drafts[k].voice?.id === id);
    if (!key) return s;
    const d = s.drafts[key];
    const next = { ...d, voice: change(d.voice!) };
    const drafts = { ...s.drafts };
    if (isEmpty(next)) delete drafts[key];
    else drafts[key] = next;
    return { drafts };
  });
}

export function textDraftOf(state: DraftsState, key: string, toUserId: string): string {
  return draftFor(state, key, toUserId)?.text ?? '';
}

export function textSendingOf(state: DraftsState, key: string, toUserId: string): boolean {
  return (draftFor(state, key, toUserId)?.textSending ?? null) !== null;
}

export function setTextDraft(key: string, toUserId: string, text: string): void {
  write(key, toUserId, (d) => ({ ...d, text }));
}

/**
 * Press Send on a text (or a picture): marks this conversation's text as sending, in one synchronous step. A second
 * press, here or in this conversation's box mounted again while the first is on its way, gets false: one message.
 */
export function claimTextSend(key: string, toUserId: string): number | null {
  if (textSendingOf(useComposerDrafts.getState(), key, toUserId)) return null;
  const token = nextTextSend;
  nextTextSend += 1;
  write(key, toUserId, (d) => ({ ...d, textSending: token }));
  return token;
}

/** The text landed (the box is emptied, unless more was typed meanwhile) or failed (it stays, for another try). */
export function endTextSend(token: number, sent: string, landed: boolean): void {
  useComposerDrafts.setState((s) => {
    const key = Object.keys(s.drafts).find((k) => s.drafts[k].textSending === token);
    if (!key) return s;
    const d = s.drafts[key];
    const next = { ...d, textSending: null, text: landed && d.text.trim() === sent.trim() ? '' : d.text };
    const drafts = { ...s.drafts };
    if (isEmpty(next)) delete drafts[key];
    else drafts[key] = next;
    return { drafts };
  });
}

export function voiceDraftOf(state: DraftsState, key: string, toUserId: string): VoiceDraft | null {
  return draftFor(state, key, toUserId)?.voice ?? null;
}

export function keepVoiceDraft(key: string, toUserId: string, blob: Blob, durationMs: number): void {
  const id = nextVoiceId;
  nextVoiceId += 1;
  write(key, toUserId, (d) => ({ ...d, voice: { id, toUserId, blob, durationMs, sending: false } }));
}

/**
 * Press Send: takes the note and marks it sending, in one synchronous step. A second press (a double click, or the
 * same conversation's box mounted again mid-upload) finds it already sending and gets null, so one note is one message.
 */
export function claimVoiceSend(key: string, toUserId: string): VoiceDraft | null {
  const voice = voiceDraftOf(useComposerDrafts.getState(), key, toUserId);
  if (!voice || voice.sending) return null;
  writeVoiceById(voice.id, (v) => ({ ...v, sending: true }));
  return voice;
}

/** The send failed: the note is back, unsent, for another try, wherever it is kept now. */
export function releaseVoiceSend(id: number): void {
  writeVoiceById(id, (v) => ({ ...v, sending: false }));
}

/** Sent: gone, wherever it is kept now (a new-message box may have become the conversation during the upload). */
export function dropVoiceById(id: number): void {
  writeVoiceById(id, () => null);
}

/** Discarded from its conversation's box. */
export function discardVoiceDraft(key: string): void {
  useComposerDrafts.setState((s) => {
    const d = s.drafts[key];
    if (!d) return s;
    const next = { ...d, voice: null };
    const drafts = { ...s.drafts };
    if (isEmpty(next)) delete drafts[key];
    else drafts[key] = next;
    return { drafts };
  });
}

/**
 * Nothing can be sent to this person any more (blocked, their conversation deleted, no longer a member): what was
 * written to them is dropped, so no unreachable note keeps the leave prompt up.
 */
export function dropDraftsTo(toUserId: string): void {
  useComposerDrafts.setState((s) => {
    const keys = Object.keys(s.drafts).filter((k) => s.drafts[k].toUserId === toUserId);
    if (keys.length === 0) return s;
    const drafts = { ...s.drafts };
    for (const k of keys) delete drafts[k];
    return { drafts };
  });
}

/** Any voice note this member has not sent, in this tab: the app asks before the tab is closed or reloaded. */
export function anyUnsentVoice(state: DraftsState, myUserId: string | null | undefined): boolean {
  if (!myUserId) return false;
  return Object.entries(state.drafts).some(([key, d]) => key.startsWith(`${myUserId}:`) && !!d.voice);
}

/** The signed-in member changed: nothing written by the last one stays in this tab. */
export function clearComposerDrafts(): void {
  useComposerDrafts.setState((s) => ({ drafts: {}, epoch: s.epoch + 1 }));
}

onMemberChange(clearComposerDrafts);

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
