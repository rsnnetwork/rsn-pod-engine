// ─── What the open invite sheet holds: who is chosen, what a send answered, the pod's counts (P29, 1 Nov 2026) ─────
// Split out of InvitePickerSheet.tsx, which now only draws. P25: what a send answered ("Invited") stands only until the
// list is read again, so an invite withdrawn elsewhere while the sheet is open frees its row as soon as the server says.
import { useEffect, useRef, useState } from 'react';
import type { InviteCandidate, InviteCandidateState } from '@rsn/shared';
import { useToastStore } from '@/stores/toastStore';
import {
  BATCH_MAX, NOT_SENT, POD_PAGES_MAX, batchSentence, canPick, countLabel, effectiveState, everyoneOnce, inviteErrorSentence,
  stateAfter, targetNoun, type InviteTarget,
} from './invite-picker';
import { useInviteCandidates, useSendInvites } from './useInviteCandidates';
import type { Chosen } from './invite-sheet-style';

/** The whole pod of an event, unsearched, read to its end (up to 200) for "This pod (n)" and "Invite everyone (n)". */
export function usePodCounts(target: InviteTarget, sent: ReadonlyMap<string, InviteCandidateState>) {
  const hasPod = target.type === 'session' && !!target.podId;
  const pod = useInviteCandidates(target, 'pod', '', hasPod);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = pod;
  const pages = pod.data?.pages.length ?? 0;
  useEffect(() => {
    // Read a pod of up to 200 to its end, so its counts are exact; a bigger one says "200+".
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError && pages < POD_PAGES_MAX) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, pages, fetchNextPage]);
  const people = everyoneOnce(pod.data?.pages ?? []);
  const complete = !!pod.data && !hasNextPage;
  return {
    hasPod,
    complete,
    count: pod.data ? countLabel(people.length, complete) : null,
    available: people.filter((p) => canPick(effectiveState(p, sent))).length,
  };
}

/** Who is chosen, what the last sends answered, and the send itself (one batch at a time, whatever the taps). */
export function useInvitePicker(target: InviteTarget, listReadAt: number) {
  const addToast = useToastStore((s) => s.addToast);
  const [chosen, setChosen] = useState<Map<string, Chosen>>(() => new Map());
  // Where people stand after a send, until the list read again says so itself (see effectiveState).
  const [sent, setSent] = useState<Map<string, InviteCandidateState>>(() => new Map());
  const sentAt = useRef(0);
  useEffect(() => {
    if (sentAt.current > 0 && listReadAt > sentAt.current) {
      sentAt.current = 0;
      setSent(new Map());
    }
  }, [listReadAt]);

  // A ref, not isPending: a double tap lands before React draws the button as disabled.
  const inFlight = useRef(false);
  const send = useSendInvites(target, {
    onSuccess: (res) => {
      const { message, tone } = batchSentence(res, targetNoun(target));
      addToast(message, tone);
      sentAt.current = Date.now();
      setSent((before) => {
        const next = new Map(before);
        for (const r of res.results) {
          const state = stateAfter(r.outcome);
          if (state) next.set(r.userId, state);
        }
        return next;
      });
      // Everyone answered for leaves the chips; someone whose invite failed stays chosen, to try again.
      setChosen((before) => {
        const next = new Map(before);
        for (const r of res.results) if (r.outcome !== 'failed') next.delete(r.userId);
        return next;
      });
    },
    onError: (err) => addToast(inviteErrorSentence(err, NOT_SENT), 'error'),
    onSettled: () => { inFlight.current = false; },
  });
  const sendNow = (ids: string[], allPodMembers = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    send.mutate({ ids, allPodMembers });
  };

  const toggle = (person: InviteCandidate) => {
    setChosen((before) => {
      const next = new Map(before);
      if (next.has(person.userId)) next.delete(person.userId);
      else if (next.size < BATCH_MAX) next.set(person.userId, { userId: person.userId, displayName: person.displayName });
      return next;
    });
  };
  const unchoose = (userId: string) => setChosen((before) => {
    const next = new Map(before);
    next.delete(userId);
    return next;
  });

  return { chosen, sent, full: chosen.size >= BATCH_MAX, sending: send.isPending, sendNow, toggle, unchoose };
}
