// ─── Ringing someone, from a profile or a thread (1 Nov 2026, 30 Oct review item 4) ─────────────────
//
// Opens the dialog that asks how long (CallRequestModal: 15 minutes and Video to start with, so it is one tap
// and Send), rings, and hands the call to the app-wide store, where the "Calling {Name}…" card waits for the
// answer on whatever screen the caller goes to. A refusal is the server's own sentence ("Bo isn't online right
// now. Send a message instead."). When the other person rang at the same moment, their call is shown to answer
// instead of an error (the second ring of a pair is refused while the first waits).

import { useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { useCallStore } from '@/stores/callStore';
import { fetchIncomingCall, fetchOutgoingCall, ringCall, type CallTarget } from './call-api';
import { fromLive, fromRung, refusalCode, ringRefusal, type CallKind } from './call-ring';

export interface CallRequestModalProps {
  open: boolean;
  kind: CallKind;
  partnerName: string | null;
  onClose: () => void;
  onSend: (kind: CallKind, durationMin: number) => void;
  sending: boolean;
}

export function useCallRequest(target: CallTarget | null, partnerName: string | null) {
  const addToast = useToastStore((s) => s.addToast);
  const outgoing = useCallStore((s) => s.outgoing);
  const [kind, setKind] = useState<CallKind | null>(null);
  const [sending, setSending] = useState(false);
  const name = partnerName?.trim() || 'them';

  /** Both rang at once: show whichever call now waits for this pair, theirs to answer or mine to wait on. */
  const showWaitingCall = async (): Promise<boolean> => {
    const askedAt = Date.now();
    const [theirs, mine] = await Promise.all([fetchIncomingCall(), fetchOutgoingCall()]).catch(() => [null, null] as const);
    const same = (c: { conversationId: string; fromUserId: string; toUserId: string } | null) =>
      !!c && (target?.conversationId ? c.conversationId === target.conversationId : c.fromUserId === target?.userId || c.toUserId === target?.userId);
    if (theirs && same(theirs)) { useCallStore.getState().setIncoming(fromLive(theirs, 'incoming', askedAt)); return true; }
    if (mine && same(mine)) { useCallStore.getState().setOutgoing(fromLive(mine, 'outgoing', askedAt)); return true; }
    return false;
  };

  const send = async (chosen: CallKind, durationMin: number) => {
    if (!target || sending) return;
    setSending(true);
    try {
      const rung = await ringCall(target, chosen, durationMin);
      useCallStore.getState().setOutgoing(fromRung(rung, partnerName?.trim() || 'Member', Date.now()));
      setKind(null);
    } catch (err) {
      if (refusalCode(err) === 'CALL_ALREADY_WAITING' && (await showWaitingCall())) {
        setKind(null);
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

  return {
    /** Open the dialog for this kind of call; nothing while one of mine is already ringing. */
    open: (k: CallKind = 'video') => { if (!outgoing) setKind(k); },
    /** One of my calls is ringing (here or anywhere): the buttons wait. */
    ringing: !!outgoing,
    modal,
  };
}
