// ─── Ringing someone, from a profile or a thread (1 Nov 2026, 30 Oct review item 4) ─────────────────
//
// Opens the dialog that asks how long (CallRequestModal: 15 minutes and Video to start with, so it is one tap
// and Send), rings, and hands the call to the app-wide store, where the "Calling {Name}…" card waits for the
// answer on whatever screen the caller goes to. A refusal is the server's own sentence ("Bo isn't online right
// now. Send a message instead."). When the other person rang at the same moment, their call is shown to answer
// instead of an error (the second ring of a pair is refused while the first waits).
//
// 11 Nov 2026 (Shirley Palmer's RSN 07): given the person's presence, a press while they are known to be offline opens
// the offline sheet (Try again, Find a time, Send a message) instead of the dialog, and so does the server's refusal
// when they went offline a moment before. Presence still loading or unknown never stops the press: the server decides.

import { useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { useCallStore } from '@/stores/callStore';
import { fetchIncomingCall, fetchOutgoingCall, ringCall, type CallTarget } from './call-api';
import { fromLive, fromRung, refusalCode, ringRefusal, type CallKind } from './call-ring';
import { rememberPlacedHere, wasPlacedHere } from './placed-here';
import { callOpensOfflineSheet, stillOffline, type SeenPresence } from './presence-words';

/** The person's presence as the screen holds it, and a way to read it again (the sheet's Try again). */
export interface CallPresence {
  state: SeenPresence;
  refresh: () => Promise<SeenPresence>;
}

/** What the offline sheet needs from the hook. */
export interface OfflineSheetProps {
  open: boolean;
  trying: boolean;
  onTryAgain: () => void;
  onClose: () => void;
}

export interface CallRequestModalProps {
  open: boolean;
  kind: CallKind;
  partnerName: string | null;
  onClose: () => void;
  onSend: (kind: CallKind, durationMin: number) => void;
  sending: boolean;
}

export function useCallRequest(target: CallTarget | null, partnerName: string | null, presence?: CallPresence) {
  const addToast = useToastStore((s) => s.addToast);
  const outgoing = useCallStore((s) => s.outgoing);
  const [kind, setKind] = useState<CallKind | null>(null);
  const [sending, setSending] = useState(false);
  // The kind of call pressed while they were offline: the offline sheet is open for it.
  const [offlineFor, setOfflineFor] = useState<CallKind | null>(null);
  const [trying, setTrying] = useState(false);
  const name = partnerName?.trim() || 'them';

  /** Both rang at once: show whichever call now waits for this pair, theirs to answer or mine to wait on. */
  const showWaitingCall = async (): Promise<boolean> => {
    const askedAt = Date.now();
    const [theirs, mine] = await Promise.all([fetchIncomingCall(), fetchOutgoingCall()]).catch(() => [null, null] as const);
    const same = (c: { conversationId: string; fromUserId: string; toUserId: string } | null) =>
      !!c && (target?.conversationId ? c.conversationId === target.conversationId : c.fromUserId === target?.userId || c.toUserId === target?.userId);
    if (theirs && same(theirs)) { useCallStore.getState().setIncoming(fromLive(theirs, 'incoming', askedAt)); return true; }
    if (mine && same(mine)) { useCallStore.getState().setOutgoing(fromLive(mine, 'outgoing', askedAt, wasPlacedHere(mine.id))); return true; }
    return false;
  };

  const send = async (chosen: CallKind, durationMin: number) => {
    if (!target || sending) return;
    setSending(true);
    try {
      const rung = await ringCall(target, chosen, durationMin);
      // Rung in this tab: only this tab goes into the room when it is answered (F3), after a refresh of it too.
      rememberPlacedHere(rung.id);
      useCallStore.getState().setOutgoing(fromRung(rung, partnerName?.trim() || 'Member', Date.now()));
      setKind(null);
    } catch (err) {
      if (refusalCode(err) === 'CALL_ALREADY_WAITING' && (await showWaitingCall())) {
        setKind(null);
        return;
      }
      // They went offline between the screen's read and the ring: the same sheet as a press while offline.
      if (refusalCode(err) === 'CALL_PARTNER_OFFLINE' && presence) {
        setKind(null);
        setOfflineFor(chosen);
        void presence.refresh();
        return;
      }
      addToast(ringRefusal(err), 'info');
      setKind(null);
    } finally {
      setSending(false);
    }
  };

  const modal: CallRequestModalProps = {
    open: kind !== null,
    kind: kind ?? 'video',
    partnerName: name === 'them' ? null : name,
    onClose: () => setKind(null),
    onSend: (k, minutes) => { void send(k, minutes); },
    sending,
  };

  // Try again: read their presence once more; back (or unknown) opens the call dialog, still offline says so.
  const tryAgain = async () => {
    if (offlineFor === null || trying || !presence) return;
    setTrying(true);
    try {
      const now = await presence.refresh();
      if (callOpensOfflineSheet(now)) {
        addToast(stillOffline(partnerName), 'info');
        return;
      }
      const k = offlineFor;
      setOfflineFor(null);
      if (!outgoing) setKind(k);
    } finally {
      setTrying(false);
    }
  };

  const offline: OfflineSheetProps = {
    open: offlineFor !== null,
    trying,
    onTryAgain: () => { void tryAgain(); },
    onClose: () => setOfflineFor(null),
  };

  return {
    /**
     * Open the dialog for this kind of call; nothing while one of mine is already ringing. Known to be offline: the
     * offline sheet instead. Never held back while presence is loading or unknown.
     */
    open: (k: CallKind = 'video') => {
      if (outgoing) return;
      if (presence && callOpensOfflineSheet(presence.state)) { setOfflineFor(k); return; }
      setKind(k);
    },
    /** One of my calls is ringing (here or anywhere): the buttons wait. */
    ringing: !!outgoing,
    modal,
    offline,
    /** Close the offline sheet (its Find a time and Send a message lead elsewhere). */
    closeOffline: () => setOfflineFor(null),
  };
}
