import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check } from 'lucide-react';
// Note: createPortal renders to document.body, but the portal CHILDREN still
// inherit React context from where the portal is declared in the tree (here,
// inside the AppLayout which lives inside <Routes>). So useNavigate works.
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { getSocket } from '@/lib/socket';
import { E } from '@/realtime/entities';
import api from '@/lib/api';
import NotificationItem from '@/features/notifications/NotificationItem';
import { useNotificationActions } from '@/features/notifications/useNotificationActions';
import { NOTIFICATIONS_KEY, type NotificationList } from '@/features/notifications/notification-logic';

// The bell: the newest 20 notifications in a panel, each drawn by the shared NotificationItem (the notifications page
// draws the same rows, 30 Oct 2026), and at its foot "See all notifications", the way to the page.

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id) as string | undefined;
  const close = useCallback(() => setOpen(false), []);
  const { actionLoading, markAllRead, acceptInvite, declineInvite, open: openNotification } = useNotificationActions(close);

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

  // Fetch the bell's list now: on opening it.
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
  // an approval or rejection notification may have arrived with it. Both read
  // the notifications again: the bell's list and, since 30 Oct 2026, the
  // notifications page's (both sit under ['notifications']); every other query
  // is refreshed by entity tags.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const readAgain = () => { void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }); };
    socket.on('notification:new', readAgain);
    socket.on('pod:membership_updated', readAgain);
    return () => {
      socket.off('notification:new', readAgain);
      socket.off('pod:membership_updated', readAgain);
    };
  }, [qc]);

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
            {notifications.map((n) => (
              <NotificationItem
                key={n.id}
                n={n}
                onOpen={() => { void openNotification(n); }}
                acting={actionLoading === n.id}
                onAcceptInvite={() => { void acceptInvite(n); }}
                onDeclineInvite={() => { void declineInvite(n); }}
                onLeave={close}
              />
            ))}
          </div>

          {/* The way to every notification, not only the newest 20 (30 Oct 2026). */}
          <Link
            to="/notifications"
            onClick={close}
            data-testid="bell-see-all"
            className="flex min-h-[44px] shrink-0 items-center justify-center border-t border-gray-100 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            See all notifications
          </Link>
        </div>
        </div>,
        document.body
      )}
    </div>
  );
}
