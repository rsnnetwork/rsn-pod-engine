// ─── The live event's open invite link (18 Sep 2026; shared 26 Oct 2026) ────────
//
// 18 Sep 2026 (Shradha): the live page's invite used to share a bare /sessions/:id
// URL under "Anyone with this link can join the event", and a member outside the
// event's private pod got "Access restricted" from it. The link is a real event
// invite instead, the same shareable invite the event page generates (a code that
// registers whoever accepts it): one open link per event, reused while it has uses
// left, created the first time it is asked for. The speed-networking host bar and
// the meeting room both use this one hook.

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

interface PendingInvite {
  code: string;
  inviteeEmail: string | null;
  maxUses?: number;
  useCount?: number;
  expiresAt?: string | null;
}

export interface EventInviteLink {
  /** The link to share, or '' while it is being prepared. */
  url: string;
  /** The pending invites could not be read, or the link could not be made. */
  failed: boolean;
}

/**
 * The event's open invite link while `open` (an invite dialog is showing). `maxUses` covers the whole event: its
 * capacity.
 */
export function useEventInviteLink(sessionId: string, open: boolean, maxUses: number): EventInviteLink {
  const qc = useQueryClient();
  const invites = useQuery({
    queryKey: ['session-pending-invites', sessionId],
    queryFn: () => api.get(`/invites/session/${sessionId}?status=pending`).then((r) => (r.data.data ?? []) as PendingInvite[]),
    enabled: open,
    meta: { entities: [E.sessionInvites(sessionId)] },
  });
  const openLink = invites.data?.find((i) =>
    !i.inviteeEmail
    && (i.useCount ?? 0) < (i.maxUses ?? 1)
    && (!i.expiresAt || new Date(i.expiresAt).getTime() > Date.now()));
  const create = useMutation({
    mutationFn: () => api.post('/invites', { type: 'session', sessionId, maxUses, expiresInHours: 168 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session-pending-invites', sessionId] }),
  });
  const { mutate: createLink } = create;
  // Made once per opening, and only once the list has settled without an open link in it.
  const asked = useRef(false);
  useEffect(() => {
    if (!open) { asked.current = false; return; }
    if (invites.isLoading || invites.isError || invites.data === undefined || openLink || asked.current) return;
    asked.current = true;
    createLink();
  }, [open, invites.isLoading, invites.isError, invites.data, openLink, createLink]);
  const code: string | undefined = openLink?.code ?? create.data?.data?.data?.code;
  return { url: code ? `${window.location.origin}/invite/${code}` : '', failed: invites.isError || create.isError };
}
