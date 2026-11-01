// client/src/features/notifications/useNotificationActions.ts
// What pressing a notification does, the same in the bell and on the notifications page (30 Oct 2026 review, item 4.5):
// mark it read and open where it points, accept or decline an invite in place, mark everything read. Moved out of
// NotificationBell.tsx unchanged in what it does.
//
// A mark is drawn at once (an optimistic update) in both lists, the bell's ['notifications'] and the page's
// ['notifications', 'page'], after cancelling any read of them on its way (an older answer must not undo it); the
// server's answer then replaces it: every change invalidates the ['notifications'] prefix, which both lists sit under.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import {
  NOTIFICATIONS_KEY, NOTIFICATIONS_PAGE_KEY, acceptedDestination, destinationOf, extractInviteCode,
  type Notification, type NotificationList,
} from './notification-logic';

/** Draws a change in both lists at once; the caller invalidates after. */
export async function patchList(qc: QueryClient, change: (n: Notification) => Notification) {
  await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
  const patchOne = (old: NotificationList): NotificationList => {
    const notifications = old.notifications.map(change);
    const readNow = old.notifications.filter((n, i) => !n.isRead && notifications[i].isRead).length;
    return { ...old, notifications, unreadCount: Math.max(0, old.unreadCount - readNow) };
  };
  qc.setQueryData<NotificationList>(NOTIFICATIONS_KEY, (old) => (old ? patchOne(old) : old));
  qc.setQueryData<InfiniteData<NotificationList>>(NOTIFICATIONS_PAGE_KEY, (old) =>
    old ? { ...old, pages: old.pages.map(patchOne) } : old);
}

/** Every list that shows invites or memberships: an answer to an invite changes them. */
function invalidateInviteCaches(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  qc.invalidateQueries({ queryKey: ['received-invites'] });
  qc.invalidateQueries({ queryKey: ['my-pods'] });
  qc.invalidateQueries({ queryKey: ['my-sessions'] });
  qc.invalidateQueries({ queryKey: ['session-participants'] });
  qc.invalidateQueries({ queryKey: ['session-detail'] });
}

/** `onLeave` runs before the page moves on (the bell closes its panel). */
export function useNotificationActions(onLeave: () => void = () => undefined) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  /** Marks these read (one row, or the messages a page line runs together). */
  const markRead = async (ids: string[]) => {
    // Mark-read failures are non-critical (UX nicety) — log to console for dev visibility but don't toast: the user has
    // already moved on. The optimistic update shows it read at once; the refetch after is the truth.
    await patchList(qc, (n) => (ids.includes(n.id) ? { ...n, isRead: true } : n));
    await Promise.all(ids.map((id) => api.post(`/notifications/${id}/read`)
      .catch((err) => console.warn('mark notification read failed', err))));
    qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  };

  const markAllRead = async () => {
    await patchList(qc, (n) => ({ ...n, isRead: true }));
    try { await api.post('/notifications/read-all'); }
    catch (err) { console.warn('mark all notifications read failed', err); }
    qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  };

  const acceptInvite = async (n: Notification) => {
    const code = extractInviteCode(n.link);
    if (!code) return;
    setActionLoading(n.id);

    // Retry-capable accept flow. The server-side acceptInvite registers the user (sessionService.registerParticipant
    // via applyInviteRegistration), so the client MUST NOT fire a second register on success — that double-fire was the
    // source of the 2026-04-28 11:00 incident where the lobby's auto-register collided with this handler's register and
    // hit the unique-constraint race in session_participants. Register is only fired in the error fallback below for
    // the specific codes that mean "already registered".
    const tryAcceptAndRegister = async (attempt: number): Promise<{ dest: string | null; success: boolean }> => {
      try {
        const res = await api.post(`/invites/${code}/accept`);
        const data = res.data?.data;
        // A circle invite lands on the circle (T14).
        return { dest: acceptedDestination({ sessionId: data?.sessionId || n.sessionId, podId: data?.podId || n.podId, circleId: data?.circleId }), success: true };
      } catch (err: any) {
        const errCode = err?.response?.data?.error?.code;
        const status = err?.response?.status;
        // Already accepted/registered — success. The register ping normalises the membership for the navigation that
        // follows; if it errors, log but don't toast (the server already told us we're fine).
        if (errCode === 'SESSION_ALREADY_REGISTERED' || errCode === 'POD_MEMBER_EXISTS' || errCode === 'INVITE_ALREADY_USED') {
          if (n.sessionId) {
            try { await api.post(`/sessions/${n.sessionId}/register`); }
            catch (regErr) { console.warn('register normalize after already-registered failed', regErr); }
          }
          return { dest: destinationOf(n), success: true };
        }
        if (errCode === 'INVITE_REVOKED' || errCode === 'INVITE_EXPIRED' || errCode === 'EVENT_ENDED') {
          addToast(errCode === 'INVITE_REVOKED' ? 'This invite has been revoked'
            : errCode === 'INVITE_EXPIRED' ? 'This invite has expired'
            : 'This event has already ended', 'error');
          return { dest: null, success: false };
        }
        // Server error (500, timeout) — retry once
        if (status >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
          return tryAcceptAndRegister(attempt + 1);
        }
        addToast(err?.response?.data?.error?.message || 'Failed to accept invite', 'error');
        return { dest: null, success: false };
      }
    };

    const { dest, success } = await tryAcceptAndRegister(1);
    if (success) {
      addToast('Invite accepted!', 'success');
      if (!n.isRead) void markRead([n.id]);
      await patchList(qc, (x) => (x.id === n.id ? { ...x, inviteStatus: 'accepted', isRead: true } : x));
      invalidateInviteCaches(qc);
      onLeave();
      if (dest) navigate(dest);
    }
    setActionLoading(null);
  };

  const declineInvite = async (n: Notification) => {
    const code = extractInviteCode(n.link);
    if (!code) return;
    setActionLoading(n.id);
    try {
      await api.post(`/invites/${code}/decline`);
      addToast('Invite declined', 'info');
      if (!n.isRead) void markRead([n.id]);
      await patchList(qc, (x) => (x.id === n.id ? { ...x, inviteStatus: 'revoked', isRead: true } : x));
      invalidateInviteCaches(qc);
    } catch {
      addToast('Failed to decline invite', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * Opens a notification: marks it (and any it stands for) read, then goes where it points.
   * - Invite (accepted) → the pod/event; (pending) → accept, then there; (declined/expired) → says so, stays.
   * - Meeting request → the conversation once accepted, else the request.
   * - Anything else → its link.
   */
  const open = async (n: Notification, alsoRead: Notification[] = [n]) => {
    const unread = alsoRead.filter((x) => !x.isRead).map((x) => x.id);
    if (unread.length > 0) void markRead(unread);

    if (n.inviteStatus === 'revoked') { addToast('This invite was declined', 'info'); return; }
    if (n.inviteStatus === 'expired') { addToast('This invite has expired', 'info'); return; }

    // For pending invites: accept first, then register, then navigate
    if (n.inviteStatus === 'pending') {
      const code = extractInviteCode(n.link);
      if (code) {
        try { await api.post(`/invites/${code}/accept`); } catch { /* accept may fail if already used — still try to register */ }
      }
    }
    // FORCE register for session invites — always, regardless of invite status
    if (n.sessionId) {
      try { await api.post(`/sessions/${n.sessionId}/register`); } catch { /* already registered is fine */ }
    }
    const dest = destinationOf(n);
    if (dest) {
      onLeave();
      navigate(dest);
    }
  };

  return { actionLoading, markRead, markAllRead, acceptInvite, declineInvite, open };
}
