// client/src/features/reason/human/ProfileCommunities.tsx
// A profile's Communities (Shirley pilot S3, 11 Nov 2026; brief RSN 14: "Display only Circles, Groups and Pods the viewer
// is permitted to discover; never expose hidden/private membership. 'Request to join' appears on discoverable approval
// gated spaces."). The server lists the rows and decides each one's button (GET /people/:id/communities); this only draws
// them. On another member's profile the section is left out when it has nothing to list (whether they are in nothing,
// turned it off or are hidden from search is not told). In "Preview as others see it" (GET /people/me/communities) it is
// what a member with no connection to you sees, and says why when that is nothing; its buttons send nothing there.
// The first 8, then "Show more" reads 24 at a time.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ProfileCommunities as Page, ProfileCommunity } from '@rsn/shared';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import { Section } from './ProfileDetails';
import { shouldRetry, statusOf } from './profile-text';
import { errorMessage, fetchCommunities, fetchMyCommunities, reasonKeys } from '../api';
import {
  COMMUNITIES_KICKER, FIRST_PAGE, MORE_PAGE, PREVIEW_NOTE, ROLE_LABEL, communitiesEntities, communitiesTitle,
  previewEmptyText, rowBadges, rowButton, rowToast, spaceHref,
} from './communities-text';

type Props =
  | { mode: 'member'; userId: string }
  | { mode: 'preview' };

type Call = 'join-circle' | 'join-pod' | 'request-pod';

const KEEP_CLEAR = 'scroll-mt-[calc(90px+env(safe-area-inset-top))] scroll-mb-[calc(100px+env(safe-area-inset-bottom))]';
const BUTTON = cn('min-h-[44px] shrink-0 rounded-[11px] px-4 text-[13px] font-bold', KEEP_CLEAR);
const CALLS: Record<Call, (id: string) => Promise<unknown>> = {
  'join-circle': (id) => api.post(`/circles/${id}/join`),
  'join-pod': (id) => api.post(`/pods/${id}/join`),
  'request-pod': (id) => api.post(`/pods/${id}/request-join`),
};

function Row({ c, busy, onCall }: { c: ProfileCommunity; busy: boolean; onCall: (c: ProfileCommunity, call: Call) => void }) {
  const button = rowButton(c);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-reason-line py-2.5 first:border-t-0" data-testid={`community-${c.kind}-${c.id}`}>
      <Link to={spaceHref(c)} className={cn('flex min-h-[44px] min-w-0 flex-[1_1_12rem] flex-col justify-center', KEEP_CLEAR)}>
        <span className="text-[14px] font-bold [overflow-wrap:anywhere]">{c.name}</span>
        <span className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-semibold text-reason-muted">
          {rowBadges(c).map((b) => <span key={b} className="rounded-full bg-[#f3f4f6] px-2 py-0.5">{b}</span>)}
          <span className="rounded-full bg-reason-pink px-2 py-0.5 text-[#5c2a26]">{ROLE_LABEL[c.role]}</span>
        </span>
      </Link>
      {button?.kind === 'call' && (
        <button
          type="button"
          onClick={() => onCall(c, button.call)}
          aria-disabled={busy || undefined}
          className={cn(BUTTON, 'bg-reason-red text-white enabled:hover:bg-reason-red-hover', busy && 'opacity-60')}
          data-testid="community-action"
        >
          {busy ? 'Sending...' : button.label}
        </button>
      )}
      {button?.kind === 'link' && (
        <Link to={button.to} className={cn(BUTTON, 'flex items-center bg-reason-red text-white hover:bg-reason-red-hover')} data-testid="community-action">
          {button.label}
        </Link>
      )}
      {button?.kind === 'waiting' && (
        <span className="flex min-h-[44px] items-center rounded-[11px] bg-[#f3f4f6] px-4 text-[13px] font-bold text-reason-muted" data-testid="community-waiting">
          {button.label}
        </span>
      )}
    </li>
  );
}

export default function ProfileCommunities(props: Props) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [busyId, setBusyId] = useState<string | null>(null);
  const preview = props.mode === 'preview';
  const them = preview ? me : props.userId;
  const queryKey = preview ? reasonKeys.myCommunities : reasonKeys.communities(props.userId);
  // The tags follow the rows already on screen (a space's own changes), read from the cache each render.
  const loaded = qc.getQueryData<InfiniteData<Page>>(queryKey)?.pages;

  const list = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const limit = pageParam === 0 ? FIRST_PAGE : MORE_PAGE;
      return preview ? fetchMyCommunities(pageParam, limit) : fetchCommunities(props.userId, pageParam, limit);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled: !!me,
    // A 4xx is an answer (the 404 of a block): asking again changes nothing.
    retry: shouldRetry,
    // Not kept once the profile closes: who may see which space changes without telling a viewer outside it, so a
    // profile opened again reads the server first rather than drawing last time's rows (a space since made private).
    gcTime: 0,
    meta: { entities: communitiesEntities(me, them, loaded) },
  });

  const act = useMutation({
    networkMode: 'always',
    mutationFn: ({ c, call }: { c: ProfileCommunity; call: Call }) => CALLS[call](c.id),
    onSuccess: (_res, { c, call }) => {
      addToast(rowToast(call, c.name), 'success');
      return qc.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      addToast(errorMessage(err, "That didn't work. Try again."), 'error');
      return qc.invalidateQueries({ queryKey });
    },
    onSettled: () => setBusyId(null),
  });

  const onCall = (c: ProfileCommunity, call: Call) => {
    if (preview) { addToast('This is a preview. Nothing is sent.', 'info'); return; }
    if (busyId) return;
    setBusyId(c.id);
    act.mutate({ c, call });
  };

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const hidden = list.data?.pages[0]?.hidden;

  if (list.isPending) {
    return (
      <div className="mt-[11px] md:mt-[18px]" aria-busy="true">
        <span className="sr-only" role="status">Loading communities</span>
        <Skeleton className="h-28 rounded-[19px] border border-reason-line bg-white md:rounded-[24px]" />
      </div>
    );
  }
  // A block or a closed account answers 404, even on a refetch: the profile itself says so, and this section goes.
  if (list.isError && statusOf(list.error) === 404) return null;
  // Any other failure shows the card only when there is nothing to show: a background refetch that fails keeps the
  // last good list on screen (React Query keeps its data), and the next tag or focus asks again.
  if (list.isError && !list.data) {
    return (
      <Section kicker={COMMUNITIES_KICKER} title="Could not load communities." className="mt-[11px] md:mt-[18px]">
        <p className="text-[14px] text-[#505762]">{errorMessage(list.error, 'Try again in a moment.')}</p>
        <button type="button" onClick={() => void list.refetch()} className={cn(BUTTON, 'mt-3 border border-reason-line bg-white')}>Try again</button>
      </Section>
    );
  }
  if (items.length === 0) {
    if (!preview) return null;
    return (
      <Section kicker={COMMUNITIES_KICKER} title="No communities shown." className="mt-[11px] md:mt-[18px]">
        <p className="text-[14px] leading-relaxed text-[#505762]" data-testid="communities-preview-empty">{previewEmptyText(hidden)}</p>
      </Section>
    );
  }

  return (
    <Section kicker={COMMUNITIES_KICKER} title={communitiesTitle(total)} className="mt-[11px] md:mt-[18px]">
      <div data-testid="profile-communities">
        <ul className="grid">
          {items.map((c) => <Row key={`${c.kind}-${c.id}`} c={c} busy={busyId === c.id} onCall={onCall} />)}
        </ul>
        {list.hasNextPage && (
          <button
            type="button"
            onClick={() => void list.fetchNextPage()}
            aria-disabled={list.isFetchingNextPage || undefined}
            className={cn(BUTTON, 'mt-2 w-full border border-reason-line bg-white sm:w-auto')}
            data-testid="communities-more"
          >
            {list.isFetchingNextPage ? 'Loading...' : `Show more (${total - items.length} more)`}
          </button>
        )}
        {preview && <p className="mt-3 text-[12px] text-reason-muted">{PREVIEW_NOTE}</p>}
      </div>
    </Section>
  );
}
