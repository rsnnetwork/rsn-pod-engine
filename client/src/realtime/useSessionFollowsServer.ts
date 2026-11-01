// ─── The session follows the server on every tab and device (final sweep F1, 2 Nov 2026) ──────────────────────────
//
// Mounted once, in App. While a member is signed in, their session is a read tagged with their own user:<id>: when
// the server says something of theirs changed (an onboarding confirmed on another device, a city added, a profile
// saved, a photo placed), or the socket connects after a gap, the session is read again into the auth store, so the
// onboarding gate lets go and the top bar follows without a reload. See session-read.ts.

import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { E } from './entities';
import { sessionReadOptions } from './session-read';

export function useSessionFollowsServer(): void {
  const memberId = useAuthStore((s) => (s.isAuthenticated && s.isSessionChecked ? (s.user?.id as string | undefined) : undefined));
  const reread = useAuthStore((s) => s.rereadSession);
  useQuery({
    ...sessionReadOptions(memberId ?? '', reread, useAuthStore.getState().user),
    enabled: !!memberId,
    meta: { entities: memberId ? [E.user(memberId)] : [] },
  });
}
