// ─── The RSN Call link's reads and writes (Part 2, Task 12) ─────────────────────────────────────────────────
//
// Every request goes through lib/api.ts and only to the call-link routes (and the guest-allowed schedule read), so a
// guest's browser never touches a member route on this flow. Server data lives in React Query: the landing, the
// person's state on the link, their events by link and their meetings; each read declares the tags the server sends
// when it changes (a place taken, a request decided, the event starting or ending).

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CallEntryState, CallEntryVerification, CallEventSummary, CallLanding, MySchedule } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { CALL_API, landingFailure } from './call-entry';

/** The tags that change what a person's call page shows: their places and requests, and the event once it is theirs. */
function callTags(userId: string, sessionId: string | null): string[] {
  return [
    E.userSessions(userId),
    E.user(userId),
    ...(sessionId ? [E.session(sessionId), E.sessionParticipants(sessionId), E.sessionGroups(sessionId)] : []),
  ];
}

const callKeys = {
  landing: (code: string, userId: string | null) => ['call-landing', code, userId] as const,
  entry: (code: string, userId: string | null) => ['call-entry', code, userId] as const,
  all: (code: string) => [['call-landing', code], ['call-entry', code]] as const,
};

/** The signed-in person's id, once the session check has answered; null for nobody. */
function useSignedInId(): { userId: string | null; checked: boolean } {
  const userId = useAuthStore((s) => (s.isAuthenticated && s.user?.id ? (s.user.id as string) : null));
  const checked = useAuthStore((s) => s.isSessionChecked && !s.isLoading);
  return { userId, checked };
}

/** The event behind `code` as anyone holding the link sees it, and, signed in, where the person stands on it. */
export function useCallLink(code: string) {
  const { userId, checked } = useSignedInId();
  // The event's id is known once the person holds a place or has asked for one; from then its own tags apply too.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const tags = userId ? callTags(userId, sessionId) : [];

  const landing = useQuery({
    queryKey: callKeys.landing(code, userId),
    queryFn: () => api.get(CALL_API.landing(code)).then((r) => r.data.data as CallLanding),
    enabled: checked && code.length > 0,
    // A link that leads nowhere is an answer, not a hiccup: asked once.
    retry: (count, err) => landingFailure(err) === 'unavailable' && count < 2,
    meta: { entities: tags },
  });

  const entry = useQuery({
    queryKey: callKeys.entry(code, userId),
    queryFn: () => api.get(CALL_API.entry(code)).then((r) => r.data.data as CallEntryState),
    enabled: checked && !!userId && landing.isSuccess,
    meta: { entities: tags },
  });

  const found = entry.data?.sessionId ?? landing.data?.viewer.sessionId ?? null;
  useEffect(() => {
    if (found) setSessionId(found);
  }, [found]);

  return { landing, entry, userId, checked };
}

export interface SendCodeInput { email: string; admissionCode?: string }
/** The proof (the typed code, or the email's button), and an admission code for an invitation-only event. */
export type VerifyInput = ({ email: string; code: string } | { token: string }) & { admissionCode?: string };
export interface EnterInput { displayName?: string; groupKeys?: string[]; admissionCode?: string }

/** Asking for the code, checking it (or the email's button), and entering. */
export function useCallActions(code: string) {
  const qc = useQueryClient();
  const setTokensAndLoad = useAuthStore((s) => s.setTokensAndLoad);
  const refresh = () => Promise.all(callKeys.all(code).map((queryKey) => qc.invalidateQueries({ queryKey })));

  const sendCode = useMutation({
    // The admission code typed beside the email stays on this page: it goes with the 6-digit code to /verify, where the
    // event decides who it takes (the email step answers every address the same).
    mutationFn: (input: SendCodeInput) => api.post(CALL_API.email(code), {
      email: input.email,
      clientUrl: window.location.origin,
    }).then((r) => r.data.data as { sent: true; devCode?: string }),
  });

  const verify = useMutation({
    mutationFn: async (input: VerifyInput) => {
      const { data } = await api.post(CALL_API.verify(code), input);
      const signedIn = data.data as CallEntryVerification;
      // The new session (an account, or the event guest just made), installed as the sign-in page installs one: the
      // session read that follows says which kind of account it is.
      await setTokensAndLoad(signedIn.accessToken, signedIn.refreshToken);
      return signedIn;
    },
  });

  const enter = useMutation({
    mutationFn: (input: EnterInput) => api.post(CALL_API.enter(code), input).then((r) => r.data.data as CallEntryState),
    onSettled: () => refresh(),
  });

  return { sendCode, verify, enter, refresh };
}

/** The signed-in person's events by link: the guest home's list. */
export function useMyCallEvents() {
  const { userId, checked } = useSignedInId();
  return useQuery({
    queryKey: ['call-my-events', userId],
    queryFn: () => api.get(CALL_API.myEvents()).then((r) => r.data.data as CallEventSummary[]),
    enabled: checked && !!userId,
    meta: { entities: userId ? [E.userSessions(userId)] : [] },
  });
}

/** A person's own meetings in an event, once its organisers have published a schedule (GET /sessions/:id/schedule/mine). */
export function useMySchedule(sessionId: string | null) {
  const { userId } = useSignedInId();
  return useQuery({
    queryKey: ['call-my-schedule', sessionId, userId],
    queryFn: async () => {
      try {
        const { data } = await api.get(CALL_API.mySchedule(sessionId!));
        return (data.data ?? null) as MySchedule | null;
      } catch (err) {
        // Before the first publish the answer is null. A 404 (an event this read cannot find) shows nothing either: the
        // waiting screen then simply has no "Your meetings" block. Anything else is a real failure and is thrown.
        const status = (err as { response?: { status?: number } } | null)?.response?.status;
        if (status === 404) return null;
        throw err;
      }
    },
    enabled: !!sessionId && !!userId,
    retry: false,
    meta: { entities: sessionId ? [E.sessionPublishedSchedule(sessionId), E.sessionMatches(sessionId), E.session(sessionId)] : [] },
  });
}
