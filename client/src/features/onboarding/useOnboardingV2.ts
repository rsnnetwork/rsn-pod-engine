// ─── Onboarding version 2: the state, and the calls that change it ──────────
//
// React Query owns the state. Every write is answered by the server's
// user:<id> tag, which refetches it here and wherever else the member is
// signed in. The endpoints are Task 8's (server/src/routes/onboarding-v2.ts).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OnboardingV2ConfirmRequest, OnboardingV2ConfirmResponse, OnboardingV2LinkedinResponse, OnboardingV2State,
} from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import type { DraftPatch } from './flow';

const onboardingV2Key = (userId: string | undefined) => ['onboarding-v2-state', userId] as const;

/**
 * While a LinkedIn lookup runs, the state is also read again every few seconds.
 * Its end is pushed through the member's user tag, but a lookup can restart for
 * a corrected address, and a socket that is reconnecting misses the push; the
 * server reads a lookup older than three minutes as failed, so this always stops.
 */
const LOOKUP_REREAD_MS = 5000;

function useMemberId(): string | undefined {
  return useAuthStore(s => (s.user?.id as string | undefined) ?? undefined);
}

export function useOnboardingV2State() {
  const userId = useMemberId();
  return useQuery({
    queryKey: onboardingV2Key(userId),
    queryFn: () => api.get('/onboarding/v2/state').then(r => r.data.data as OnboardingV2State),
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId)] : [] },
    refetchInterval: (query) => (query.state.data?.linkedin.status === 'searching' ? LOOKUP_REREAD_MS : false),
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
