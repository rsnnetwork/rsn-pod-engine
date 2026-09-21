// Whether the wizard is still owed, and recording how it was left.
//
// Server state, not a flag in the browser: closing the tab mid-tour, or
// finishing onboarding on a phone and opening the laptop, must not mean seeing
// it twice or never. Only someone who has just finished the new flow is ever
// shown it — tour_due_at is stamped at confirm — so nobody who onboarded
// before it existed is interrupted, and neither are test accounts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingState } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';

export function useTourState() {
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);

  const { data } = useQuery({
    queryKey: ['onboarding-state'],
    queryFn: () => api.get('/onboarding/state').then(r => r.data.data as OnboardingState),
    enabled: !!user?.id,
    meta: { entities: user?.id ? [E.user(user.id)] : [] },
  });

  const markSeen = useMutation({
    mutationFn: (outcome: 'completed' | 'skipped') =>
      api.post('/onboarding/tour', { outcome }).then(r => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: ['onboarding-state'] }),
  });

  return {
    pending: !!data?.tour.pending,
    markSeen: (outcome: 'completed' | 'skipped') => markSeen.mutate(outcome),
  };
}
