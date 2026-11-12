// client/src/features/reason/profile/ShareProfileCard.tsx
// "Share your profile" on Your profile (Shirley pilot S6, RSN 12): copy your member link, and an opt-in public link for people who are not on REASON yet (D5), with Copy, Make a new link and Turn off. Turning off
// and making a new link both kill the old link, so both ask first.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicProfileLinkState } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { useConfirm } from '@/hooks/useConfirm';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import {
  errorMessage, fetchPublicLink, makePublicLinkRequest, reasonKeys, regeneratePublicLinkRequest, revokePublicLinkRequest,
} from '../api';
import { BUSY } from '../human/busy';
import { SHARE_WORDS, publicLinkFor } from './share-text';
import { useCopyLink, useCopyMemberLink } from './useCopyLink';

const PRIMARY = 'flex min-h-[44px] items-center justify-center rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white hover:bg-reason-red-hover';
const QUIET = 'flex min-h-[44px] items-center justify-center rounded-[11px] border border-reason-line bg-white px-4 text-[14px] font-bold hover:bg-reason-soft';
const BODY = 'text-[13px] leading-relaxed text-[#505762] [overflow-wrap:anywhere]';

type LinkMove = 'make' | 'remake' | 'revoke';
const MOVE_REQUEST: Record<LinkMove, () => Promise<PublicProfileLinkState>> = {
  make: makePublicLinkRequest, remake: regeneratePublicLinkRequest, revoke: revokePublicLinkRequest,
};
const MOVE_DONE: Record<LinkMove, string> = { make: SHARE_WORDS.made, remake: SHARE_WORDS.remade, revoke: SHARE_WORDS.revoked };

export default function ShareProfileCard() {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const { ask, confirmDialog } = useConfirm();
  const copy = useCopyLink();
  const copyMemberLink = useCopyMemberLink();

  // Your link follows user:<you>: made, replaced or turned off on another device, or paused by hiding your profile.
  const state = useQuery({
    queryKey: reasonKeys.myPublicLink,
    queryFn: fetchPublicLink,
    enabled: !!me,
    meta: { entities: me ? [E.user(me)] : [] },
  });

  // networkMode 'always': offline, a press fails at once and says so. It returns the refresh, so the buttons stay busy
  // until the card shows where the link stands now.
  const move = useMutation({
    networkMode: 'always',
    mutationFn: (m: LinkMove) => MOVE_REQUEST[m](),
    onSuccess: (_result, m) => {
      addToast(MOVE_DONE[m], m === 'revoke' ? 'info' : 'success');
      return qc.invalidateQueries({ queryKey: reasonKeys.mine });
    },
    onError: (err) => {
      addToast(errorMessage(err, 'Could not change your public link right now. Try again in a moment.'), 'error');
      return qc.invalidateQueries({ queryKey: reasonKeys.myPublicLink });
    },
  });
  const busy = move.isPending;

  const press = async (m: LinkMove) => {
    if (busy) return;
    if (m === 'revoke' && !(await ask({ title: SHARE_WORDS.revokeTitle, body: SHARE_WORDS.revokeBody, confirmLabel: 'Turn off', tone: 'danger' }))) return;
    if (m === 'remake' && !(await ask({ title: SHARE_WORDS.remakeTitle, body: SHARE_WORDS.remakeBody, confirmLabel: 'Make a new link', tone: 'danger' }))) return;
    move.mutate(m);
  };

  const link = state.data?.link ?? null;
  const url = link ? publicLinkFor(window.location.origin, link.path) : null;

  return (
    <section className="min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:rounded-[24px] md:p-6" aria-labelledby="share-profile" data-testid="share-profile">
      <p className="text-[11px] font-extrabold uppercase tracking-[0.11em]">Share</p>
      <h2 id="share-profile" className="mt-3.5 text-[22px] font-bold tracking-[-0.035em] md:text-[24px]">Share your profile</h2>
      <p className={cn(BODY, 'mt-1.5')}>Your member link opens your profile for members who are signed in.</p>
      <div className="mt-3.5 flex flex-wrap gap-2.5">
        <button type="button" onClick={() => void copyMemberLink()} className={QUIET} data-testid="copy-member-link">Copy member link</button>
      </div>

      <div className="mt-5 border-t border-reason-line pt-4">
        <h3 className="text-[16px] font-bold">Public link</h3>
        {state.isPending ? (
          <div className="mt-2 grid gap-2" aria-busy="true">
            <span className="sr-only" role="status">Loading your public link</span>
            <Skeleton className="h-4 w-3/4 rounded" />
            <Skeleton className="h-11 w-40 rounded-[11px]" />
          </div>
        ) : state.isError ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className={BODY}>{errorMessage(state.error, 'We could not load your public link just now.')}</p>
            <button type="button" onClick={() => void state.refetch()} className={QUIET}>Try again</button>
          </div>
        ) : link && url ? (
          <div className="mt-2 grid gap-2.5">
            {state.data?.paused === 'hidden' && (
              <p role="status" className="rounded-[12px] border border-[#f3d9a4] bg-[#fff8e8] p-3 text-[13px] leading-relaxed text-[#5c4a1e]" data-testid="public-link-paused">{SHARE_WORDS.paused}</p>
            )}
            <p className={BODY}>{SHARE_WORDS.consent}</p>
            <input
              readOnly
              value={url}
              aria-label="Your public link"
              onFocus={(e) => e.currentTarget.select()}
              className="h-11 w-full min-w-0 rounded-[11px] border border-reason-line bg-reason-soft px-3 text-[16px] md:text-[14px]"
              data-testid="public-link-url"
            />
            <div className="flex flex-wrap gap-2.5">
              <button type="button" onClick={() => void copy(url, SHARE_WORDS.publicCopied)} className={PRIMARY} data-testid="copy-public-link">Copy public link</button>
              <button type="button" onClick={() => void press('remake')} aria-disabled={busy || undefined} className={cn(QUIET, busy && BUSY)} data-testid="regenerate-public-link">Make a new link</button>
              <button type="button" onClick={() => void press('revoke')} aria-disabled={busy || undefined} className={cn(QUIET, busy && BUSY)} data-testid="revoke-public-link">Turn off</button>
            </div>
          </div>
        ) : (
          <div className="mt-2 grid gap-2.5">
            <p className={BODY}>Off. Make a link to show your profile to people who are not on REASON yet.</p>
            <p className={BODY}>{SHARE_WORDS.consent}</p>
            <div>
              <button type="button" onClick={() => void press('make')} aria-disabled={busy || undefined} className={cn(PRIMARY, busy && BUSY)} data-testid="make-public-link">
                {busy ? 'Making your link...' : 'Make a public link'}
              </button>
            </div>
          </div>
        )}
      </div>
      {confirmDialog}
    </section>
  );
}
