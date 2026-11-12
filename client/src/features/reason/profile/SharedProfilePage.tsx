// client/src/features/reason/profile/SharedProfilePage.tsx
// /p/:token, a member's public profile link (Shirley pilot S6, D5), open to anyone who holds it, signed in or not. It
// shows the public card only (PublicCardView) and, for someone who is not a member, the way to ask to join; never a way
// to contact the member. A link that opens nothing (turned off, replaced, never made, its member hidden or gone, a
// block) is one "not available" page, as the server answers one 404 for all of them. Kept out of search engines.
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { Skeleton } from '@/components/ui/Spinner';
import ReasonMark from '../brand/ReasonMark';
import ReasonSheep from '../brand/ReasonSheep';
import { errorMessage, fetchPublicProfile, reasonKeys } from '../api';
import { isGone, shouldRetry } from '../human/profile-text';
import PublicCardView from './PublicCardView';

const PRIMARY = 'flex min-h-[44px] items-center justify-center rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white hover:bg-reason-red-hover';
// The header's two buttons beside the mark fit a 360px phone.
const HEADER_BUTTON = 'flex min-h-[44px] items-center justify-center rounded-[11px] px-3 text-[13px] font-bold';
const SIDES = 'pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] md:pl-[max(22px,env(safe-area-inset-left))] md:pr-[max(22px,env(safe-area-inset-right))]';

/** A robots tag for as long as the page is open: a person's page is never indexed, whatever finds the link. */
function useNoIndex() {
  useEffect(() => {
    const tag = document.createElement('meta');
    tag.name = 'robots';
    tag.content = 'noindex, nofollow';
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);
}

export default function SharedProfilePage() {
  const { token = '' } = useParams();
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  useNoIndex();

  // A page anyone may hold, read signed out with no socket: it names no member to follow, and a link its owner turns
  // off answers 404 at the next read.
  // realtime: skip — signed-out public page, nothing to follow
  const profile = useQuery({
    queryKey: reasonKeys.publicProfile(token),
    queryFn: () => fetchPublicProfile(token),
    enabled: token.length > 0,
    retry: shouldRetry,
  });

  return (
    <div className="min-h-[100dvh] bg-[#f6f5f3] font-reason text-reason-ink antialiased">
      <header className="sticky top-0 z-[5] flex h-[calc(60px+env(safe-area-inset-top))] items-center justify-between gap-3 border-b border-reason-line bg-white/95 pl-[max(11px,env(safe-area-inset-left))] pr-[max(11px,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur-lg md:h-[calc(70px+env(safe-area-inset-top))] md:pl-[max(24px,env(safe-area-inset-left))] md:pr-[max(24px,env(safe-area-inset-right))]">
        <ReasonMark variant="mobile" />
        {signedIn ? (
          <Link to="/" className={`${HEADER_BUTTON} border border-reason-line bg-white`}>Open REASON</Link>
        ) : (
          <div className="flex items-center gap-2">
            <Link to="/login" className={`${HEADER_BUTTON} border border-reason-line bg-white`}>Sign in</Link>
            <Link to="/request-to-join" className={`${HEADER_BUTTON} bg-reason-red text-white hover:bg-reason-red-hover`}>Join REASON</Link>
          </div>
        )}
      </header>

      <main className={`mx-auto w-full max-w-[1284px] py-3 md:py-6 ${SIDES}`}>
        {profile.data ? (
          <PublicCardView card={profile.data} />
        ) : profile.isPending && token ? (
          <div className="grid gap-3" aria-busy="true">
            <span className="sr-only" role="status">Loading this profile</span>
            <Skeleton className="h-[40vh] rounded-[21px] border border-reason-line bg-white" />
          </div>
        ) : !token || isGone(profile.error) ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center" data-testid="public-link-unavailable">
            <ReasonSheep pose="thinking" className="h-24 w-24" />
            <h1 className="text-[20px] font-bold">This profile link is not available.</h1>
            <p className="text-[14px] text-[#646a77]">Its owner may have turned it off or made a new one. Ask them for their current link.</p>
            <Link to={signedIn ? '/' : '/login'} className={`${PRIMARY} mt-2`}>{signedIn ? 'Open REASON' : 'Go to REASON'}</Link>
          </div>
        ) : (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
            <ReasonSheep pose="thinking" className="h-24 w-24" />
            <h1 className="text-[20px] font-bold">We could not load this profile just now.</h1>
            <p className="text-[14px] text-[#646a77]">{errorMessage(profile.error, 'Try again in a moment.')}</p>
            <button type="button" onClick={() => void profile.refetch()} className={`${PRIMARY} mt-2`}>Try again</button>
          </div>
        )}
      </main>
    </div>
  );
}
