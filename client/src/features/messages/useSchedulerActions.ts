// What the scheduler's actions do: the confirm card (opened on a time, seeded from a standing meeting), Save, Confirm
// or Move, Discard and closing. A save never moves a meeting that stands (S1's server rule): it opens the Move card on
// the new time, and the member presses Move.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { errorMessage } from '@/features/reason/errors';
import {
  NOT_SHARED, cardBlock, cardClosedText, cardSeed, confirmFailure, confirmable, confirmedMessage, dayKeyOf,
  isOwnConfirm, lastingRefusal, meetingLength, sameMeeting, saveMessage, saveOutcome, type CellState, type OwnConfirm,
} from './scheduler-flow';
import { schedulingKey, type Scheduling } from './scheduling-types';
import type { SchedulerData } from './useSchedulerData';
import type { SchedulerDraft } from './useSchedulerDraft';

interface ActionOptions {
  conversationId: string;
  zone: string;
  me: string | undefined;
  onClose?: () => void;
  model: SchedulerData;
  draft: SchedulerDraft;
  selectDay: (dayKey: string) => void;
  reveal: (key: string, panel: boolean) => void;
  panelRef: RefObject<HTMLDivElement>;
  /** Open the confirm card on this time (the thread card's time). `at` lets the same time be asked for twice. */
  confirmRequest?: { slot: string; at: number } | null;
}

export function useSchedulerActions(o: ActionOptions) {
  const { conversationId, zone, me, onClose, model, draft, selectDay, reveal, panelRef, confirmRequest } = o;
  const { data, savedMine, theirSet, bookedKey, standing, now, dataUpdatedAt } = model;
  const { mine, saved, typed, unsaved, setAsking, durationText, meetingKind, setDurationText, setMeetingKind, forgetDraft, toggle } = draft;
  const addToast = useToastStore(s => s.addToast);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The shared time being confirmed (or the standing meeting being moved to).
  const [finalizing, setFinalizing] = useState<string | null>(null);
  // The meeting the open card was opened on, the length and kind it seeded, and when.
  const cardBasis = useRef<{ meeting: Scheduling['confirmed']; seed: { duration: string; kind: string } | null; openedAt: number } | null>(null);
  // A refusal pressing again would only repeat: its reason stays on the card, its button waits, until the
  // scheduling the panel reads changes (a new answer from the server is a new object; the same answer is not).
  const [refusal, setRefusal] = useState<{ slot: string; text: string; on: Scheduling | undefined } | null>(null);
  // This member's own Confirm or Move that succeeded, until the panel has heard it back.
  const ownConfirm = useRef<OwnConfirm | null>(null);
  // Failures said for this card, taken down once a retry succeeds.
  const failureToasts = useRef<string[]>([]);

  // The card opens on a time. Moving a meeting that stands keeps its own length
  // and kind (a 45-minute audio meeting stays so) unless the member changes them.
  const showCard = (slot: string, meeting: Scheduling['confirmed'] | undefined) => {
    const seed = cardSeed(meeting, Date.now());
    if (seed) { setDurationText(seed.duration); setMeetingKind(seed.kind); }
    cardBasis.current = { meeting: meeting ?? null, seed, openedAt: Date.now() };
    setRefusal(null);
    setAsking(false);
    setFinalizing(slot);
    selectDay(dayKeyOf(slot, zone));
    reveal(slot, false);
  };

  // The meeting changed under the open card (the partner booked it, moved it,
  // changed its length or kind, or cancelled it): the card's choice is gone, and
  // Move would quietly undo their change. Close it and say where the meeting is.
  // This member's own Save or Confirm on its way is not that: its answer decides.
  // Nor is the panel catching up with this member's own Move: a card opened
  // before it heard (on the meeting as it was) quietly follows the meeting.
  useEffect(() => {
    if (!data) return;
    const caughtUp = isOwnConfirm(data.confirmed, ownConfirm.current, now);
    if (caughtUp) ownConfirm.current = null;
    const basis = cardBasis.current;
    if (!finalizing || !basis || confirming || saving) return;
    if (sameMeeting(basis.meeting, data.confirmed, now)) return;
    if (caughtUp) {
      const seed = cardSeed(data.confirmed, now);
      const untouched = !basis.seed || (durationText === basis.seed.duration && meetingKind === basis.seed.kind);
      if (seed && untouched) { setDurationText(seed.duration); setMeetingKind(seed.kind); }
      cardBasis.current = { ...basis, meeting: data.confirmed, seed };
      return;
    }
    setFinalizing(null);
    addToast(cardClosedText(finalizing, data.confirmed, zone, now), 'info');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per answer from the server, or once a request settles
  }, [data, confirming, saving]);

  // What stands in the way of the card's button, said only when it is true.
  const cardReason = !finalizing
    ? null
    : refusal && refusal.slot === finalizing && refusal.on === data
      ? refusal.text
      : cardBlock(finalizing, {
        now,
        bothSaved: savedMine.has(finalizing) && theirSet.has(finalizing),
        freshSinceOpen: !!cardBasis.current && dataUpdatedAt > cardBasis.current.openedAt,
      });

  // The confirm card for a time both have saved: from a green cell, a chip, or
  // the thread card's time. A time that is no longer shared is said so, not opened.
  const openConfirm = (slot: string) => {
    if (!confirmable(data?.overlap ?? [], Date.now()).includes(slot) || slot === bookedKey) {
      addToast(NOT_SHARED, 'info');
      return;
    }
    showCard(slot, data?.confirmed);
  };

  // The thread card's time asks for its own confirm card, once per press.
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!confirmRequest || !data || handledRequest.current === confirmRequest.at) return;
    handledRequest.current = confirmRequest.at;
    openConfirm(confirmRequest.slot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new press, or the times arriving for one already made
  }, [confirmRequest, data]);

  const requestClose = () => {
    if (saving) return;
    if (unsaved) { setAsking(true); return; }
    onClose?.();
  };

  // The booked time itself: show the meeting at the top of the panel, with Join.
  const pressCell = (state: CellState, key: string) => {
    if (state === 'booked') {
      if (panelRef.current) panelRef.current.scrollTop = 0;
      return;
    }
    return state === 'agreed' ? openConfirm(key) : toggle(key);
  };

  const removeTime = (key: string) => {
    draft.unpick(key);
    setFinalizing(null);
  };

  const durationMin = meetingLength(durationText);
  const durationOk = durationMin !== null;

  const refreshThread = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: schedulingKey(conversationId) }),
    // The card the server wrote lands in the thread: the REAL thread key.
    queryClient.invalidateQueries({ queryKey: ['dm-messages', conversationId] }),
    queryClient.invalidateQueries({ queryKey: ['dm-conversations'] }),
  ]);

  // Saving SENDS: the thread gets a line either way (19 Sep: "we both have
  // saved our availability?" / "I have no clue!!!"), and since 25 Oct the save
  // that leaves one shared time books it. The server's answer says which.
  const save = async () => {
    if (saving || !data) return;
    setSaving(true);
    const known = data.confirmed;
    const windows = typed && !mine.has(typed) ? [...mine, typed] : [...mine];
    const added = windows.filter(w => !saved.has(w));
    try {
      const res = await api.put(`/dm/conversations/${conversationId}/scheduling/availability`, {
        windows,
        ...(durationOk ? { durationMin } : {}),
        type: meetingKind,
      });
      const after = res.data.data as Scheduling;
      const outcome = saveOutcome(after, { me, known, added }, Date.now());
      // Said at once, from the save's own answer, which also stands for the member's saved times until the panel
      // reads the server again; that refresh follows without anyone waiting on it.
      forgetDraft(after);
      const asks = outcome.kind === 'move' || outcome.kind === 'move-choice';
      addToast(saveMessage(outcome, zone), asks ? 'info' : 'success');
      void refreshThread();
      if (outcome.kind === 'move') {
        // A save never moves a meeting: the Move card opens on the new time, and the member decides.
        showCard(outcome.to, after.confirmed);
        return;
      }
      if (outcome.kind === 'overlap' || outcome.kind === 'move-choice') {
        // Times you both can, and nothing booked or moved: picking one is the
        // next step, so it stays in front of you (the top of the panel).
        if (panelRef.current) panelRef.current.scrollTop = 0;
        return;
      }
      // Booked, or only sent: the job is done, hand the thread back (Shradha's
      // deck: a terminal action, "right now it traps you").
      onClose?.();
    } catch (err) {
      addToast(errorMessage(err, 'Could not save your times. Try again.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    forgetDraft();
    setFinalizing(null);
    onClose?.();
  };

  // One request books the time, or moves the meeting there. If it fails nothing
  // changed on the server: the card stays open to try again (it says so itself
  // if the time is no longer shared), and the toast says why and where the
  // meeting is. Either way the toast comes first and the button is free at
  // once; the panel's own refresh follows without anyone waiting on it (on a
  // bad connection that refresh can take a minute).
  const confirm = async (key: string) => {
    if (confirming || durationMin === null || !data) return;
    setConfirming(key);
    const moving = standing;
    const stays = data.confirmed?.startAt ?? null;
    try {
      // The slot IS the instant — the server stores it and every client
      // renders it in its own timezone.
      await api.post(`/dm/conversations/${conversationId}/scheduling/confirm`, { window: key, durationMin, type: meetingKind });
      setFinalizing(null);
      ownConfirm.current = { window: key, durationMin, type: meetingKind };
      dismissFailures();
      addToast(confirmedMessage(key, zone, moving), 'success');
      void refreshThread();
    } catch (err) {
      const message = confirmFailure(err, { moving, stays, zone, now: Date.now() });
      failureToasts.current.push(message);
      addToast(message, 'error');
      // Pressing again would only repeat this refusal: Move waits, its reason on the card, until something changes.
      const lasting = lastingRefusal(err);
      if (lasting) setRefusal({ slot: key, text: lasting, on: queryClient.getQueryData<Scheduling>(schedulingKey(conversationId)) });
      void queryClient.invalidateQueries({ queryKey: schedulingKey(conversationId) });
    } finally {
      setConfirming(null);
    }
  };

  // A retry that worked takes down the failures said before it, so "Meeting
  // moved" is not read under "Could not move the meeting".
  const dismissFailures = () => {
    const { toasts, removeToast } = useToastStore.getState();
    for (const t of toasts) if (t.type === 'error' && failureToasts.current.includes(t.message)) removeToast(t.id);
    failureToasts.current = [];
  };

  // "Add to calendar" — a universal .ics download (Google, Outlook, Apple…),
  // not a Google-only link (Stefan, 9 Sep 2026).
  const downloadIcs = async () => {
    try {
      const res = await api.get(`/dm/conversations/${conversationId}/meeting.ics`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/calendar' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'reason-meeting.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      addToast('Could not build the calendar file. Try again.', 'error');
    }
  };

  return {
    saving, confirming, finalizing, setFinalizing, cardReason, openConfirm, requestClose, pressCell, removeTime, save,
    discard, confirm, downloadIcs,
  };
}
