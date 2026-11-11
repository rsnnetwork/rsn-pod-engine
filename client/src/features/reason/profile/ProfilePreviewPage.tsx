// client/src/features/reason/profile/ProfilePreviewPage.tsx
// "Preview as others see it", /profile/preview (Shirley pilot S6, RSN 12: "Preview must respect every privacy and
// membership setting"). Full screen, like a member's Human Profile, because that is what it is: your own Human Profile
// exactly as a signed-in member with no connection to you is sent it (GET /people/me/preview, built by the server's own
// brief assembly), drawn by the very components that member's screen draws. Their bar at the bottom is there too; in
// the preview its buttons send nothing. While your public link is on, a second tab shows what the link shows to
// someone who is not signed in, read from the link itself.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PublicProfileLinkState } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import ReasonSheep from '../brand/ReasonSheep';
import ProfileBanner from '../human/ProfileBanner';
import ProfileHero from '../human/ProfileHero';
import ProfileDetails from '../human/ProfileDetails';
import MoveBar from '../human/MoveBar';
import { isGone, personFacts } from '../human/profile-text';
import { errorMessage, fetchMyPreview, fetchPublicLink, fetchPublicProfile, reasonKeys } from '../api';
import PublicCardView from './PublicCardView';
import { SHARE_WORDS } from './share-text';

const SIDES = 'pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] md:pl-[max(22px,env(safe-area-inset-left))] md:pr-[max(22px,env(safe-area-inset-right))]';
const MAIN = 'mx-auto w-full max-w-[1264px] md:max-w-[1284px]';
const PRIMARY = 'flex min-h-[44px] items-center justify-center rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white hover:bg-reason-red-hover';
const TAB = 'flex min-h-[44px] items-center justify-center rounded-full px-4 text-[13px] font-extrabold';

type View = 'members' | 'public';

function Loading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <span className="sr-only" role="status">Loading the preview</span>
      <Skeleton className="h-[40vh] rounded-[21px] border border-reason-line bg-white" />
      <Skeleton className="h-40 rounded-[21px] border border-reason-line bg-white" />
    </div>
  );
}

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <ReasonSheep pose="thinking" className="h-24 w-24" />
      <h2 className="text-[20px] font-bold">We could not load the preview just now.</h2>
      <p className="text-[14px] text-[#646a77]">{errorMessage(error, 'Try again in a moment.')}</p>
      <button type="button" onClick={onRetry} className={cn(PRIMARY, 'mt-2')}>Try again</button>
    </div>
  );
}

/** What your public link shows signed out, read from the link itself. */
function PublicTab({ me, link }: { me: string; link: PublicProfileLinkState }) {
  const token = link.link?.token ?? '';
  const card = useQuery({
    queryKey: reasonKeys.publicProfile(token),
    queryFn: () => fetchPublicProfile(token),
    enabled: !!token && !link.paused,
    retry: false,
    meta: { entities: [E.user(me)] },
  });
  if (link.paused === 'hidden') {
    return <p role="status" className="rounded-[14px] border border-[#f3d9a4] bg-[#fff8e8] p-4 text-[14px] leading-relaxed text-[#5c4a1e]">{SHARE_WORDS.paused}</p>;
  }
  if (card.data) return <PublicCardView card={card.data} />;
  if (card.isPending) return <Loading />;
  if (isGone(card.error)) {
    return <p role="status" className="rounded-[14px] border border-reason-line bg-white p-4 text-[14px] leading-relaxed">Your public link opens nothing right now. Open Your profile to see where it stands.</p>;
  }
  return <Failed error={card.error} onRetry={() => void card.refetch()} />;
}

export default function ProfilePreviewPage() {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const hidden = useAuthStore((s) => s.user?.profileVisible === false);
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const [view, setView] = useState<View>('members');

  // Your profile changes (a save, a new photo or banner, on any device) are user:<you>; an entity you join, leave or
  // that is approved is user:<you>:entities.
  const preview = useQuery({
    queryKey: reasonKeys.myPreview,
    queryFn: fetchMyPreview,
    enabled: !!me,
    meta: { entities: me ? [E.user(me), E.userEntities(me)] : [] },
  });
  const link = useQuery({
    queryKey: reasonKeys.myPublicLink,
    queryFn: fetchPublicLink,
    enabled: !!me,
    meta: { entities: me ? [E.user(me)] : [] },
  });
  const hasLink = !!link.data?.link;
  const shown: View = hasLink ? view : 'members';
  const inPreview = () => addToast('This is a preview. Nothing is sent.', 'info');

  return (
    <div className="min-h-[100dvh] bg-[#f6f5f3] font-reason text-reason-ink antialiased">
      <header className="sticky top-0 z-[5] border-b border-reason-line bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur-lg">
        <div className="flex min-h-[60px] items-center justify-between gap-3 pl-[max(11px,env(safe-area-inset-left))] pr-[max(11px,env(safe-area-inset-right))] md:min-h-[70px] md:pl-[max(24px,env(safe-area-inset-left))] md:pr-[max(24px,env(safe-area-inset-right))]">
          <button type="button" onClick={() => navigate('/profile')} className="min-h-[44px] rounded-full border border-reason-line bg-white px-3.5 text-[13px] font-extrabold">← Back to your profile</button>
          <span className="rounded-full bg-[#111216] px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.1em] text-white">Preview</span>
        </div>
        <div className="border-t border-reason-line bg-reason-pink pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] py-2.5 md:pl-[max(24px,env(safe-area-inset-left))]" data-testid="preview-notice">
          <p className="text-[13px] font-semibold leading-snug [overflow-wrap:anywhere]">
            {shown === 'members'
              ? 'This is how a member who has not met you sees your profile.'
              : 'This is what your public link shows to anyone, even people who are not signed in.'}
            {shown === 'members' && hidden && ' You are hidden from search, so members only reach it from a link.'}
          </p>
          {hasLink && (
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Who is looking">
              <button type="button" aria-pressed={shown === 'members'} onClick={() => setView('members')} className={cn(TAB, shown === 'members' ? 'bg-[#111216] text-white' : 'border border-reason-line bg-white')}>A member</button>
              <button type="button" aria-pressed={shown === 'public'} onClick={() => setView('public')} className={cn(TAB, shown === 'public' ? 'bg-[#111216] text-white' : 'border border-reason-line bg-white')} data-testid="preview-public-tab">Your public link</button>
            </div>
          )}
        </div>
      </header>

      <main className={cn(MAIN, SIDES, 'pt-3 md:pt-6', shown === 'members' ? 'pb-[calc(116px+env(safe-area-inset-bottom))]' : 'pb-[calc(24px+env(safe-area-inset-bottom))]')}>
        {shown === 'public' && link.data && me ? (
          <PublicTab me={me} link={link.data} />
        ) : preview.data && me ? (
          <div data-testid="member-preview">
            {preview.data.person.bannerUrl && (
              <div className="mb-[11px] md:mb-[18px]">
                <ProfileBanner src={preview.data.person.bannerUrl} />
              </div>
            )}
            <ProfileHero brief={preview.data} who={personFacts(preview.data.person)} source={null} userId={me} />
            <ProfileDetails brief={preview.data} who={personFacts(preview.data.person)} source={null} onRecordOutcome={inPreview} />
          </div>
        ) : preview.isError ? (
          <Failed error={preview.error} onRetry={() => void preview.refetch()} />
        ) : (
          <Loading />
        )}
        <p className="mt-4 text-center text-[13px] text-reason-muted">
          <Link to="/profile" className="font-bold underline">Back to your profile</Link> to change what is shown.
        </p>
      </main>
      {shown === 'members' && preview.data && (
        <MoveBar brief={preview.data} busy={false} onPrimary={inPreview} onToggleSave={inPreview} onToggleRemove={inPreview} />
      )}
    </div>
  );
}
