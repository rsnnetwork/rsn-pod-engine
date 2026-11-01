import { useInfiniteQuery } from '@tanstack/react-query';
import { Bell, Check, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import NotificationItem from './NotificationItem';
import { useNotificationActions } from './useNotificationActions';
import {
  NOTIFICATIONS_PAGE_KEY, NOTIFICATIONS_PAGE_SIZE, pageSections, rowsOfPages, type NotificationList,
} from './notification-logic';

// /notifications: every notification, in one list (30 Oct 2026 review, item 4.5). Stefan: "Add a place to see all
// notifications in one list (like Facebook)." The bell shows the newest 20 and its foot links here. Newest first, under
// Today, Yesterday and Earlier, thirty at a time with "Load more". Several messages in a row from one conversation read
// as one line here ("Shradha sent you 3 messages"); the bell keeps each. Pressing a line marks it read and opens it; an
// invite or a request is answered in place, as in the bell. The list is live: the member's notifications tag reads it
// again (every loaded page), and so does a pushed notification (the bell's listener reads the ['notifications'] prefix).

const fetchPage = (before: string | undefined) =>
  api.get('/notifications', { params: { limit: NOTIFICATIONS_PAGE_SIZE, ...(before ? { before } : {}) } })
    .then((r) => r.data.data as NotificationList);

export default function NotificationsPage() {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const list = useInfiniteQuery({
    queryKey: NOTIFICATIONS_PAGE_KEY,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: NotificationList) => last.nextBefore ?? undefined,
    enabled: !!me,
    meta: { entities: me ? [E.userNotifications(me)] : [] },
  });
  const { actionLoading, markAllRead, acceptInvite, declineInvite, open } = useNotificationActions();

  const pages = list.data?.pages ?? [];
  const rows = rowsOfPages(pages);
  const unread = pages[0]?.unreadCount ?? 0;
  const sections = pageSections(rows);

  return (
    <div className="mx-auto w-full max-w-2xl" data-testid="notifications-page">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-bold text-[#1a1a2e]">
          <Bell className="h-5 w-5 text-gray-500" aria-hidden="true" /> Notifications
        </h1>
        {unread > 0 && (
          <button
            type="button"
            onClick={() => { void markAllRead(); }}
            className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-gray-700 hover:bg-gray-100"
          >
            <Check className="h-4 w-4" aria-hidden="true" /> Mark all as read
          </button>
        )}
      </div>

      {/* A change re-reads every loaded page, and pages have their own limit on the server (sixty reads a minute); a
          re-read that fails (that limit, or the network) keeps the list shown and says so, with Try again, rather than
          leaving it quietly out of date (T6 fix round 1). */}
      {list.isRefetchError && (
        <div role="alert" data-testid="notifications-stale" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2">
          <p className="text-sm text-gray-800">This list could not be brought up to date.</p>
          <button
            type="button"
            onClick={() => { void list.refetch(); }}
            className="min-h-[44px] rounded-lg px-3 text-sm font-semibold text-gray-800 hover:bg-amber-100"
          >
            Try again
          </button>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {list.isPending && !list.isError && <PageSkeleton />}
        {list.isError && !list.data && (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-sm text-gray-700">We could not load your notifications.</p>
            <button
              type="button"
              onClick={() => { void list.refetch(); }}
              className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Try again
            </button>
          </div>
        )}
        {list.data && rows.length === 0 && (
          <p data-testid="notifications-empty" className="px-4 py-10 text-center text-sm text-gray-500">No notifications yet</p>
        )}
        {sections.map((section) => (
          <section key={section.day} aria-label={section.day}>
            <h2 className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {section.day}
            </h2>
            {section.entries.map((entry) => (
              <NotificationItem
                key={entry.key}
                n={entry.lead}
                title={entry.title}
                isRead={entry.isRead}
                onOpen={() => { void open(entry.lead, entry.members); }}
                acting={actionLoading === entry.lead.id}
                onAcceptInvite={() => { void acceptInvite(entry.lead); }}
                onDeclineInvite={() => { void declineInvite(entry.lead); }}
                onLeave={() => undefined}
              />
            ))}
          </section>
        ))}
      </div>

      {list.hasNextPage && (
        <button
          type="button"
          onClick={() => { void list.fetchNextPage(); }}
          disabled={list.isFetchingNextPage}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {list.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Load more
        </button>
      )}
      {list.isFetchNextPageError && (
        <p role="alert" className="mt-2 text-center text-sm text-red-600">More notifications could not be loaded. Try again.</p>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div data-testid="notifications-loading" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-start gap-2 border-b border-gray-50 px-4 py-4">
          <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gray-200" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  );
}
