// ─── The wall ────────────────────────────────────────────────────────────────
//
// One feed for the circle wall and the pod wall (26 Oct 2026, COM-01). The circle wall came first (REASON
// v1 Phase 4, 20 Jul): posts with pictures and links, comments with replies, reactions, pinning. The pod
// wall is the same feed on other routes, so what differs lives in a WallConfig (where it reads and writes,
// which entity tags its queries declare, whether it polls, its words) and the components in this folder
// are drawn from it. Everything they DECIDE is in wall-logic.ts.
//
// Live updates. Both walls' routes send entity tags (the circle wall's since Shirley pilot S4, 11 Nov 2026), and each
// query declares them in meta.entities: the app-wide handler refetches a query when a tag it declares arrives, so no
// wall polls. A phone that dropped its connection missed whatever was sent meanwhile: the app-wide handler refetches
// every tagged query when the socket connects again (P1 item 17), so the wall keeps no listener of its own.
//
// S4: an author's edit of a post is held here (useHeldPostEdit), so a refetch never loses what was typed. A ?post= link
// to a post that has gone says "This post was removed." where it would be (WallNotices).

import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import WallComposer from './WallComposer';
import { LinkedPostNotice, WallNotMember } from './WallNotices';
import WallPostCard from './WallPostCard';
import { useHeldPostEdit } from './useHeldPostEdit';
import {
  arrangeFeed, createCoalescer, isForbidden, isNotFound, retryUnlessAnswered, revealedPosts, viewerFor, wallErrorSentence,
} from './wall-logic';
import type { WallConfig, WallFeedPage, WallPost, WallViewer } from './wall-types';

/** "Show more" reveals this many posts at a time when the wall shows only the first few. */
const SHOW_MORE_STEP = 10;

/** A burst of refetches is read once per this long (ms): short enough to feel live, long enough to fold a storm. */
const REFETCH_WINDOW_MS = 200;

export { WallNotMember };

export default function Wall({ config, fallbackViewer, highlightPostId, onFeedPodStatus }: {
  config: WallConfig;
  /** What the viewer may do, for a wall whose feed does not say (the circle wall's page knows). */
  fallbackViewer?: WallViewer;
  /** The post a ?post= link names: scrolled into view and outlined. */
  highlightPostId?: string;
  /** Told the pod's status each time the feed's first page reads a new one (the pod wall's feed says it). */
  onFeedPodStatus?: (status: string) => void;
}) {
  const userId = useAuthStore((s) => s.user?.id);
  const queryClient = useQueryClient();
  const [shown, setShown] = useState(config.visibleAtFirst);
  const [removedHere, setRemovedHere] = useState<string[]>([]);
  const [coalesce] = useState(() => createCoalescer(REFETCH_WINDOW_MS));
  const tagged = config.entities.feed.length > 0;

  const feed = useInfiniteQuery({
    queryKey: config.keys.feed,
    queryFn: ({ pageParam }) => {
      const read = () => api.get(pageParam ? `${config.feedPath}?cursor=${encodeURIComponent(pageParam)}` : config.feedPath)
        .then((r) => r.data.data as WallFeedPage);
      // A burst of tags (a storm of reactions) asks for the feed again and again: the first page of a refetch waits
      // for its window and shares one request with the rest of the burst. The first load and the pages after the
      // first are read at once.
      const refetching = pageParam === undefined && tagged && queryClient.getQueryData(config.keys.feed) !== undefined;
      return refetching ? coalesce(read) : read();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: retryUnlessAnswered,
    meta: { entities: config.entities.feed },
  });

  const { pinned, rest, viewer: fromFeed } = arrangeFeed(feed.data?.pages);
  const viewer = viewerFor(fromFeed, fallbackViewer);
  const feedPodStatus = feed.data?.pages[0]?.podStatus;
  useEffect(() => {
    if (feedPodStatus) onFeedPodStatus?.(feedPodStatus);
  }, [feedPodStatus, onFeedPodStatus]);
  const loadedIds = new Set([...pinned, ...rest].map((p) => p.id));

  // The ?post= link: a post on the pages loaded so far is scrolled to where it stands. One that is not (older
  // than the first page, or gone) is fetched alone and shown on top. A post the member has just deleted here
  // is not fetched again.
  const wanted = highlightPostId && !removedHere.includes(highlightPostId) ? highlightPostId : undefined;
  const linked = useQuery<WallPost>({
    queryKey: config.keys.post(wanted ?? ''),
    queryFn: () => api.get(`${config.itemBase}/posts/${wanted}`).then((r) => r.data.data as WallPost),
    enabled: wanted !== undefined && feed.isSuccess && !loadedIds.has(wanted),
    retry: false,
    meta: { entities: config.entities.post(wanted ?? '') },
  });
  const linkedPost = wanted !== undefined && !linked.isError && !loadedIds.has(wanted) ? linked.data : undefined;
  // S4: a link to a post that has gone (removed, or hidden from this viewer: the server answers both alike, 404) says so
  // where the post would be, rather than in a toast that is gone before it is read. Fix round 1: only a 404 says that;
  // a phone that is offline, or a server fault, says what went wrong and offers to try again.
  const held = useHeldPostEdit(config, { ids: loadedIds, rest, linkedPostId: linkedPost?.id });
  const linkedOut = wanted !== undefined && !loadedIds.has(wanted) && linked.isError && held.editingId !== wanted;
  const linkedGone = linkedOut && isNotFound(linked.error);
  const linkedFailed = linkedOut && !isNotFound(linked.error);

  // The acting screen refreshes itself when its own change settles: a change that changed nothing (the same
  // reaction again) is answered 200 and sent to no one, so it gets no echo, and a moderator who is not a
  // member is not in the audience at all.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: config.keys.feed, exact: true });
    if (wanted) void queryClient.invalidateQueries({ queryKey: config.keys.post(wanted), exact: true });
  };

  const visible = revealedPosts(rest, shown, highlightPostId);

  // The post whose edit is open, when it is not among the cards drawn below.
  const heldPost = held.heldFor(new Set([...(linkedPost ? [linkedPost.id] : []), ...pinned.map((p) => p.id), ...visible.map((p) => p.id)]));
  const hasMore = rest.length > visible.length || !!feed.hasNextPage;
  const showMore = () => {
    if (config.visibleAtFirst === undefined) { void feed.fetchNextPage(); return; }
    const target = visible.length + SHOW_MORE_STEP;
    setShown(target);
    if (rest.length < target && feed.hasNextPage) void feed.fetchNextPage();
  };

  if (feed.isPending) {
    return (
      <div className="space-y-3" data-testid={`${config.testId}-loading`} aria-busy="true">
        <Skeleton className="h-16" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }

  if (feed.isError && isForbidden(feed.error) && config.copy.notMember) return <WallNotMember config={config} />;

  if (feed.isError && !feed.data) {
    return (
      <Card className="!p-4 text-center" data-testid={`${config.testId}-error`}>
        <p className="text-sm text-gray-600">{wallErrorSentence(feed.error, config.copy.loadFailed)}</p>
        <Button variant="ghost" onClick={() => void feed.refetch()} className="mt-2 min-h-[44px]">Try again</Button>
      </Card>
    );
  }

  const card = (p: WallPost, showPinBadge: boolean, isLinked = false, gone = false) => (
    <WallPostCard
      key={p.id} config={config} post={p} viewer={viewer} userId={userId}
      showPinBadge={showPinBadge} linked={isLinked} highlighted={p.id === highlightPostId}
      onChanged={refresh}
      onRemoved={(id) => setRemovedHere((ids) => [...ids, id])}
      edit={held.editOf(p)}
      onEdit={held.editFor(p)}
      gone={gone}
    />
  );

  return (
    <div className="space-y-3" data-testid={config.testId}>
      {feed.isError && (
        <p className="text-center text-xs text-gray-500" role="status">
          {wallErrorSentence(feed.error, config.copy.loadFailed)} Showing what was loaded before.
        </p>
      )}

      {viewer.canPost ? (
        <WallComposer config={config} onSettled={refresh} />
      ) : (
        <Card className="!p-4">
          <p className="text-center text-sm text-gray-500" data-testid={`${config.testId}-cannot-post`}>{config.copy.cannotPost}</p>
        </Card>
      )}

      {heldPost && card(heldPost.post, false, false, heldPost.gone)}
      {(linkedGone || linkedFailed) && (
        <LinkedPostNotice config={config} removed={linkedGone} error={linked.error} onRetry={() => void linked.refetch()} />
      )}
      {linkedPost && card(linkedPost, !!linkedPost.pinnedAt, true)}
      {pinned.map((p) => card(p, true))}
      {visible.map((p) => card(p, false))}

      {visible.length === 0 && pinned.length === 0 && !linkedPost && !heldPost && (
        <p className="py-4 text-center text-sm text-gray-400" data-testid={`${config.testId}-empty`}>
          {viewer.canPost ? config.copy.empty : config.copy.emptyReadOnly}
        </p>
      )}

      {hasMore && (
        <Button variant="ghost" onClick={showMore} disabled={feed.isFetchingNextPage} className="min-h-[44px] w-full" data-testid={`${config.testId}-load-more`}>
          {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
