// The member's own standard meeting request (Stefan, 21 Nov 2026): the note and the format their requests start
// with, saved on Edit profile. The Meet sheet opens on them and the profile form edits them, so both read this one
// query. They are the member's own row (GET /users/me), which only they are sent; a save on any of their devices is
// user:<them>, so an open sheet or form follows it without a refresh.
import { useQuery } from '@tanstack/react-query';
import type { MeetingFormat, User } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';

export interface MeetDefaults {
  /** The note as saved, {first} and all; null when the member keeps REASON's own. */
  note: string | null;
  /** The format as saved; null when the member keeps the 20 minute video conversation. */
  format: MeetingFormat | null;
}

export const meetDefaultsKey = (userId: string | undefined) => ['meet-defaults', userId] as const;

export function useMeetDefaults() {
  const userId = useAuthStore((s) => s.user?.id as string | undefined);
  return useQuery({
    queryKey: meetDefaultsKey(userId),
    queryFn: () => api.get('/users/me').then((r): MeetDefaults => {
      const me = r.data.data as User;
      return { note: me.meetNoteDefault ?? null, format: me.meetFormatDefault ?? null };
    }),
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId)] : [] },
  });
}
