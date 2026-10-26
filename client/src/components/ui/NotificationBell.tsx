import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, CheckCircle, X, Loader2 } from 'lucide-react';
// Note: createPortal renders to document.body, but the portal CHILDREN still
// inherit React context from where the portal is declared in the tree (here,
// inside the AppLayout which lives inside <Routes>). So useNavigate works.
// The old comment claiming otherwise was wrong; window.location.href was the
// lazy workaround that caused the page-reload UX everyone complained about.
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { getSocket } from '@/lib/socket';
import { E } from '@/realtime/entities';
import api from '@/lib/api';
import { bellRequestView, type BellRequestView, type RequestStateLike } from '@/features/messages/request-answer';
import { useRequestAnswer } from '@/features/messages/useRequestAnswer';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  isRead: boolean;
  createdAt: string;
  inviteStatus?: string | null; // 'pending' | 'accepted' | 'revoked' | 'expired'
  podId?: string | null;
  sessionId?: string | null;
  /** Where the meeting request behind a `poke` row stands, as the server says (25 Oct 2026). */
  requestState?: RequestStateLike | null;
  /** The older field for the same answer, read only from a server that sends no requestState. */
  pokeStatus?: 'accepted' | 'declined' | null;
}

/** GET /notifications: the last 20, and how many are unread. */
interface NotificationList {
  notifications: Notification[];
  unreadCount: number;
}

const INVITE_TYPES = ['pod_invite', 'event_invite'];
const NOTIFICATIONS_KEY = ['notifications'] as const;

/** Extract invite code from `/invite/{code}` link */
function extractInviteCode(link?: string): string | null {
  if (!link) return null;
  const match = link.match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

/** Get the in-app destination for a notification */
function getDestination(n: Notification): string | null {
  if (n.sessionId) return `/sessions/${n.sessionId}`;
  if (n.podId) return `/pods/${n.podId}`;
  // A meeting request goes to the conversation once accepted, else to the request.
  const request = bellRequestView(n);
  if (request) return request.destination;
  // For non-invite notifications, use the link directly
  if (n.link && !n.link.startsWith('/invite/')) return n.link;
  // For invite notifications, navigate to the invite page so user can see details
  if (n.link && n.link.startsWith('/invite/')) return n.link;
  return null;
}

/**
 * The list as it will be once a change lands, drawn at once (an optimistic
 * update). A bell fetch already on its way is cancelled first, so its older
 * answer cannot land on top and briefly undo the change. The server's answer
 * replaces it: every caller invalidates after.
 */
async function patchList(qc: QueryClient, change: (n: Notification) => Notification) {
  await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
  qc.setQueryData<NotificationList>(NOTIFICATIONS_KEY, (old) => {
    if (!old) return old;
    const notifications = old.notifications.map(change);
    const readNow = old.notifications.filter((n, i) => !n.isRead && notifications[i].isRead).length;
    return { notifications, unreadCount: Math.max(0, old.unreadCount - readNow) };
  });
}

export default function NotificationBell() {
  // Auth store removed — onboarding check moved to ProtectedRoute
  const [open, setOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id) as string | undefined;

  // Outside click handled by portal backdrop — no separate listener needed

  // P2-2 — the poll is PAUSED inside a live event: nobody reads notifications
  // mid-round, and it was ~240 useless requests per user over a 2h event, each
  // one waking the tab. A pushed notification still refreshes the list there.
  const { pathname } = useLocation();
  const inLiveEvent = pathname.startsWith('/session/') && pathname.includes('/live');

  // 26 Oct 2026: the list is React Query's, keyed ['notifications'] and
  // refreshed by the member's notifications tag, which the server emits for a
  // request answered anywhere (this tab, another tab, another device). It used
  // to live in this component's state and forget any answer it had not made
  // itself, so an accepted request offered Accept again (25 Oct).
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => api.get('/notifications').then((r) => r.data.data as NotificationList),
    enabled: !!me,
    refetchInterval: inLiveEvent ? false : 30_000,
    meta: { entities: me ? [E.userNotifications(me)] : [] },
  });
  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;

  // Fetch the bell's list now: on opening it, and when a notification is pushed.
  const fetchNotifications = useCallback(() => { void refetch(); }, [refetch]);

  // Leaving a live event catches up at once instead of waiting out the poll.
  // On the first render the list is already on its way, and this joins it.
  useEffect(() => {
    if (inLiveEvent) return;
    void refetch({ cancelRefetch: false });
  }, [inLiveEvent]);

  // Bug 32 (19 May Ali) — two thin socket listeners. notification:new: a
  // notification was pushed to this member (not every sender of one emits the
  // notifications tag as well). pod:membership_updated (Bug 3, 18 May Stefan):
  // an approval or rejection notification may have arrived with it. Both only
  // fetch the bell's own list; every other query is refreshed by entity tags.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    socket.on('notification:new', fetchNotifications);
    socket.on('pod:membership_updated', fetchNotifications);
    return () => {
      socket.off('notification:new', fetchNotifications);
      socket.off('pod:membership_updated', fetchNotifications);
    };
  }, [fetchNotifications]);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropPos({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328)),
      });
    }
    setOpen(!open);
    if (!open) fetchNotifications();
  };

  const markRead = async (id: string) => {
    // Mark-read failures are non-critical (UX nicety) — log to console for
    // dev visibility but don't toast: the user has already moved on. The
    // optimistic update below shows it read at once; the refetch after is the truth.
    await patchList(qc, (n) => (n.id === id ? { ...n, isRead: true } : n));
    try { await api.post(`/notifications/${id}/read`); }
    catch (err) { console.warn('mark notification read failed', err); }
    qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  };

  const markAllRead = async () => {
    await patchList(qc, (n) => ({ ...n, isRead: true }));
    try { await api.post('/notifications/read-all'); }
    catch (err) { console.warn('mark all notifications read failed', err); }
    qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  };

  /** Invalidate all caches that display invite/membership data */
  const invalidateInviteCaches = () => {
    qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    qc.invalidateQueries({ queryKey: ['received-invites'] });
    qc.invalidateQueries({ queryKey: ['my-pods'] });
    qc.invalidateQueries({ queryKey: ['my-sessions'] });
    qc.invalidateQueries({ queryKey: ['session-participants'] });
    qc.invalidateQueries({ queryKey: ['session-detail'] });
  };

  const handleAcceptInvite = async (n: Notification) => {
    const code = extractInviteCode(n.link);
    if (!code) return;
    setActionLoading(n.id);

    // Retry-capable accept flow. The server-side acceptInvite now registers
    // the user in Phase B (sessionService.registerParticipant via
    // applyInviteRegistration), so the client MUST NOT fire a second
    // register on success — that double-fire was the source of the
    // 2026-04-28 11:00 incident where the lobby's auto-register collided
    // with this handler's register and hit the unique-constraint race in
    // session_participants. Register is only fired in the error fallback
    // below for the specific codes that mean "already registered" (where
    // the server tells us we don't need to re-do anything).
    const tryAcceptAndRegister = async (attempt: number): Promise<{ dest: string | null; success: boolean }> => {
      try {
        const res = await api.post(`/invites/${code}/accept`);
        const data = res.data?.data;
        const sessionId = data?.sessionId || n.sessionId;
        const podId = data?.podId || n.podId;

        const dest = sessionId ? `/sessions/${sessionId}` : podId ? `/pods/${podId}` : null;
        return { dest, success: true };
      } catch (err: any) {
        const errCode = err?.response?.data?.error?.code;
        const status = err?.response?.status;

        // Already accepted/registered — success. Server says we're in. We
        // still ping register so the membership state is normalized for the
        // navigation that follows; if it errors, log but don't toast (the
        // server already told us we're fine).
        if (errCode === 'SESSION_ALREADY_REGISTERED' || errCode === 'POD_MEMBER_EXISTS'
            || errCode === 'INVITE_ALREADY_USED') {
          if (n.sessionId) {
            try { await api.post(`/sessions/${n.sessionId}/register`); }
            catch (regErr) { console.warn('register normalize after already-registered failed', regErr); }
          }
          return { dest: getDestination(n), success: true };
        }

        // Permanent failures — don't retry
        if (errCode === 'INVITE_REVOKED' || errCode === 'INVITE_EXPIRED' || errCode === 'EVENT_ENDED') {
          addToast(errCode === 'INVITE_REVOKED' ? 'This invite has been revoked'
            : errCode === 'INVITE_EXPIRED' ? 'This invite has expired'
            : 'This event has already ended', 'error');
          return { dest: null, success: false };
        }

        // Server error (500, timeout) — retry once
        if (status >= 500 && attempt < 2) {
          await new Promise(r => setTimeout(r, 1000));
          return tryAcceptAndRegister(attempt + 1);
        }

        addToast(err?.response?.data?.error?.message || 'Failed to accept invite', 'error');
        return { dest: null, success: false };
      }
    };

    const { dest, success } = await tryAcceptAndRegister(1);

    if (success) {
      addToast('Invite accepted!', 'success');
      if (!n.isRead) markRead(n.id);
      await patchList(qc, (x) => (x.id === n.id ? { ...x, inviteStatus: 'accepted', isRead: true } : x));
      invalidateInviteCaches();
      setOpen(false);
      // SPA navigation — no more page reload (the white-flash UX everyone hated).
      // useNavigate works here because the bell is rendered inside the React
      // Router context (AppLayout → ProtectedRoute → Routes).
      if (dest) navigate(dest);
    }

    setActionLoading(null);
  };

  const handleDeclineInvite = async (n: Notification) => {
    const code = extractInviteCode(n.link);
    if (!code) return;
    setActionLoading(n.id);
    try {
      await api.post(`/invites/${code}/decline`);
      addToast('Invite declined', 'info');
      if (!n.isRead) markRead(n.id);
      await patchList(qc, (x) => (x.id === n.id ? { ...x, inviteStatus: 'revoked', isRead: true } : x));
      invalidateInviteCaches();
    } catch {
      addToast('Failed to decline invite', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * Click handler for notification title. Navigates based on type + status:
   * - Invite (accepted) → go to the pod/session
   * - Invite (pending) → do nothing (use Accept/Decline buttons)
   * - Invite (declined/expired) → toast, no navigation
   * - Meeting request → the conversation once accepted, else the request
   * - Other notification types → navigate to link destination
   */
  const handleClick = async (n: Notification) => {
    if (!n.isRead) markRead(n.id);

    if (n.inviteStatus === 'revoked') {
      addToast('This invite was declined', 'info');
      return;
    }
    if (n.inviteStatus === 'expired') {
      addToast('This invite has expired', 'info');
      return;
    }

    // For pending invites: accept first, then register, then navigate
    if (n.inviteStatus === 'pending') {
      const code = extractInviteCode(n.link);
      if (code) {
        try {
          await api.post(`/invites/${code}/accept`);
        } catch { /* accept may fail if already used — still try to register */ }
      }
    }

    // FORCE register for session invites — always, regardless of invite status
    if (n.sessionId) {
      try { await api.post(`/sessions/${n.sessionId}/register`); } catch { /* already registered is fine */ }
    }

    // Navigate to destination
    const dest = getDestination(n);
    if (dest) {
      setOpen(false);
      navigate(dest);
    }
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  /** Only show action buttons for pending invites */
  const canActOnInvite = (n: Notification) =>
    INVITE_TYPES.includes(n.type) && extractInviteCode(n.link) && n.inviteStatus === 'pending';

  /** Status label for resolved invites */
  const getInviteStatusLabel = (n: Notification) => {
    if (!INVITE_TYPES.includes(n.type) || !n.inviteStatus || n.inviteStatus === 'pending') return null;
    if (n.inviteStatus === 'accepted') return { text: 'Accepted', color: 'text-emerald-700' };
    if (n.inviteStatus === 'revoked') return { text: 'Declined', color: 'text-gray-500' };
    if (n.inviteStatus === 'expired') return { text: 'Expired', color: 'text-amber-700' };
    return null;
  };

  return (
    <div ref={ref} className="relative z-50">
      <button ref={btnRef} onClick={handleOpen} aria-label="Notifications" className="relative flex h-11 w-11 items-center justify-center text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors">
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-rsn-red text-white text-[10px] font-bold rounded-full px-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)}>
          {/* Backdrop overlay for mobile */}
          <div className="absolute inset-0 bg-black/20 sm:bg-transparent" />
          {/* Notification panel — stopPropagation prevents backdrop close on panel click.
              A flex column, so that when the panel is capped at 80vh it is the list that gives way and the header
              keeps its height: a phone in landscape is ~390px tall, and 80vh of that is shorter than the header
              and the list together, which used to cut off the bottom of the list. pb: on a phone the panel is a
              sheet on the bottom edge of the screen, where the home indicator is. */}
          <div className="absolute z-[9999] sm:rounded-xl rounded-t-2xl bg-white shadow-xl border border-gray-200 overflow-hidden
            flex flex-col pb-[env(safe-area-inset-bottom)] sm:pb-0
            inset-x-0 bottom-0 sm:inset-auto sm:w-80 max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
            style={dropPos && typeof window !== 'undefined' && window.innerWidth >= 640 ? {
              top: dropPos.top,
              left: dropPos.left,
            } : undefined}>
          {/* Header: 44px tall with or without the button (the title carries the padding; the button is the 44px touch target and its side padding is pulled back out, so the words stay where they were) */}
          <div className="flex shrink-0 items-center justify-between px-4 border-b border-gray-100">
            <h3 className="py-3 text-sm font-semibold text-gray-700">Notifications</h3>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-rsn-red hover:underline flex items-center gap-1 min-h-[44px] px-2 -mr-2">
                <Check className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>

          {/* List: up to 20rem, and smaller when the panel is capped, scrolling inside what is left */}
          <div className="min-h-0 flex-1 overflow-y-auto max-h-80">
            {isPending && !isError && (
              <p className="text-sm text-gray-500 text-center py-6">Loading...</p>
            )}
            {isError && !data && (
              <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                <p className="text-sm text-gray-600">We could not load your notifications.</p>
                <button
                  onClick={fetchNotifications}
                  className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-4 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Try again
                </button>
              </div>
            )}
            {data && notifications.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-6">No notifications yet</p>
            )}
            {notifications.map(n => {
              const showActions = canActOnInvite(n);
              const statusLabel = getInviteStatusLabel(n);
              const isActing = actionLoading === n.id;
              const isClickable = true; // All notifications are clickable — navigate to destination
              const request = bellRequestView(n);

              return (
                <div
                  key={n.id}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors ${!n.isRead ? 'bg-blue-50/40' : ''}`}
                >
                  {/* Clickable title area */}
                  <button
                    onClick={() => handleClick(n)}
                    className={`min-h-[44px] w-full text-left ${isClickable ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.isRead && <div className="mt-1.5 w-2 h-2 rounded-full bg-rsn-red shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={`text-sm leading-snug ${!n.isRead ? 'font-medium text-gray-800' : 'text-gray-600'}`}>{n.title}</p>
                          {statusLabel && (
                            <span className={`text-[10px] font-medium shrink-0 ${statusLabel.color}`}>{statusLabel.text}</span>
                          )}
                        </div>
                        {/* pre-line: a meeting request's note and "Why REASON suggested this:"
                            arrive as two paragraphs, and were run together on one line (5 Oct 2026).
                            line-clamp-6: a body made of many single line breaks (a message preview, a
                            wall post, a request's note) would otherwise make one entry thousands of
                            pixels tall and push its own Accept and Decline out of reach. The whole text
                            is one tap away, on the page the entry opens. */}
                        {n.body && <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-line break-words line-clamp-6">{n.body}</p>}
                        <p className="text-[10px] text-gray-500 mt-1">{formatTime(n.createdAt)}</p>
                      </div>
                    </div>
                  </button>

                  {/* Inline Accept / Decline for PENDING invite notifications only. Both Accept buttons in this panel are REASON's green darkened until a white label reads on it (the old emerald-500 was 2.54:1; green-fill is 4.60:1, 5.80:1 hovered). Not the brand red: red reads as the opposite of accepting. */}
                  {showActions && (
                    <div className="flex items-center gap-2 mt-2 ml-4">
                      <button
                        onClick={() => handleAcceptInvite(n)}
                        disabled={isActing}
                        className="flex min-h-[44px] items-center gap-1 px-4 text-xs font-medium rounded-full bg-reason-green-fill text-white hover:bg-reason-green-fill-hover disabled:opacity-50 transition-colors"
                      >
                        {isActing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                        Accept
                      </button>
                      <button
                        onClick={() => handleDeclineInvite(n)}
                        disabled={isActing}
                        className="flex min-h-[44px] items-center gap-1 px-4 text-xs font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                      >
                        <X className="h-3 w-3" />
                        Decline
                      </button>
                    </div>
                  )}
                  {/* Meeting request: what the server says it is, answered here; accept lands in the conversation. */}
                  {request && <BellRequestActions n={n} view={request} onDone={() => setOpen(false)} />}
                </div>
              );
            })}
          </div>
        </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * A meeting request's row in the bell (4 Sep 2026, Ali: "accept or reject inside the bell, and once accepted it should
 * take me directly into the chat"). Waiting: Accept and Decline. Answered, here or anywhere else: "Accepted" or
 * "Declined", from the server, with nothing left to press. Busy while ANY surface is answering this request.
 */
function BellRequestActions({ n, view, onDone }: { n: Notification; view: BellRequestView; onDone: () => void }) {
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  // Accepting again what is already accepted is a 200 with the same
  // conversation, so a stale row lands in the thread too. The other answer
  // given elsewhere is a 409: the hook says so and the row redraws.
  const { answer, busy: isActing, answering } = useRequestAnswer(view.requestId, {
    onAccepted: (result) => {
      onDone();
      navigate(result.conversationId ? `/messages/${result.conversationId}` : '/messages');
    },
    onDeclined: () => addToast('Request declined', 'info'),
  });

  const handleAcceptPoke = () => answer('accept');
  const handleDeclinePoke = () => answer('decline');

  if (view.canAnswer) {
    return (
      <div className="flex items-center gap-2 mt-2 ml-4" data-testid={`poke-actions-${n.id}`}>
        <button
          onClick={() => handleAcceptPoke()}
          disabled={isActing}
          className="flex min-h-[44px] items-center gap-1 rounded-full bg-reason-green-fill px-4 text-xs font-medium text-white transition-colors hover:bg-reason-green-fill-hover disabled:opacity-50"
        >
          {answering === 'accept' ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
          Accept
        </button>
        <button
          onClick={() => handleDeclinePoke()}
          disabled={isActing}
          className="flex min-h-[44px] items-center gap-1 rounded-full bg-gray-100 px-4 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200 disabled:opacity-50"
        >
          {answering === 'decline' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          Decline
        </button>
      </div>
    );
  }
  if (!view.label) return null;
  return (
    <p className={`ml-4 mt-1 text-[10px] font-medium ${view.label === 'Accepted' ? 'text-emerald-700' : 'text-gray-500'}`}>
      {view.label}
    </p>
  );
}
