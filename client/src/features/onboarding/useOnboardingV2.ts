// ─── Onboarding version 2: the state, and the calls that change it ──────────
//
// React Query owns the state. Every write is answered by the server's
// user:<id> tag, which refetches it here and wherever else the member is
// signed in. The endpoints are Task 8's (server/src/routes/onboarding-v2.ts).

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OnboardingV2ConfirmRequest, OnboardingV2ConfirmResponse, OnboardingV2LinkedinResponse, OnboardingV2State,
} from '@rsn/shared';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import type { DraftPatch } from './flow';

const onboardingV2Key = (userId: string | undefined) => ['onboarding-v2-state', userId] as const;

function useMemberId(): string | undefined {
  return useAuthStore(s => (s.user?.id as string | undefined) ?? undefined);
}

/**
 * The onboarding state. It changes under the member's user tag: every write
 * here, and the end of a LinkedIn lookup, which the server sends when it ends.
 * A socket that dropped and came back has missed whatever was sent meanwhile,
 * so while this state is on screen it is read again each time the socket
 * connects. Only this query: nothing else on the page is re-read for it.
 */
export function useOnboardingV2State() {
  const userId = useMemberId();
  const qc = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    const resync = () => { void qc.invalidateQueries({ queryKey: ['onboarding-v2-state'] }); };
    socket.on('connect', resync);
    return () => { socket.off('connect', resync); };
  }, [qc]);
  return useQuery({
    queryKey: onboardingV2Key(userId),
    queryFn: () => api.get('/onboarding/v2/state').then(r => r.data.data as OnboardingV2State),
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId)] : [] },
  });
}

/** Everything that reads the member's onboarding: this flow's state, and the tour's (which reads version 1's). */
function useRefreshOnboarding() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['onboarding-v2-state'] }),
    qc.invalidateQueries({ queryKey: ['onboarding-state'] }),
  ]);
}

/** PUT /onboarding/v2/answers: the draft, as each question is left. */
export function useSaveDraft() {
  return useMutation({
    mutationFn: (patch: DraftPatch) => api.put('/onboarding/v2/answers', patch).then(() => undefined),
  });
}

/** POST /onboarding/v2/linkedin: saves the link and starts (or reuses) the lookup. */
export function useConnectLinkedin() {
  const refresh = useRefreshOnboarding();
  return useMutation({
    mutationFn: (url: string) => api.post('/onboarding/v2/linkedin', { url }).then(r => r.data.data as OnboardingV2LinkedinResponse),
    onSuccess: () => refresh(),
  });
}

/** POST /onboarding/v2/linkedin/skip: "Continue with email". */
export function useSkipLinkedin() {
  return useMutation({
    mutationFn: () => api.post('/onboarding/v2/linkedin/skip', {}).then(() => undefined),
  });
}

/** POST /onboarding/v2/confirm. The gate is read from the auth store, so the session is re-read before anything navigates. */
export function useConfirm() {
  const refresh = useRefreshOnboarding();
  const checkSession = useAuthStore(s => s.checkSession);
  return useMutation({
    mutationFn: (body: OnboardingV2ConfirmRequest) =>
      api.post('/onboarding/v2/confirm', body).then(r => r.data.data as OnboardingV2ConfirmResponse),
    onSuccess: async () => {
      await checkSession();
      await refresh();
    },
  });
}

/** PUT /users/me with a new photo, already made small in the browser. */
export function useUploadPhoto() {
  const refresh = useRefreshOnboarding();
  const checkSession = useAuthStore(s => s.checkSession);
  return useMutation({
    mutationFn: (dataUrl: string) => api.put('/users/me', { avatarUrl: dataUrl }).then(() => undefined),
    onSuccess: async () => {
      await checkSession();
      await refresh();
    },
  });
}
