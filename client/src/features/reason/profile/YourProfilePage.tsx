// client/src/features/reason/profile/YourProfilePage.tsx
// "Your profile", at /profile (21 Oct 2026). Stefan: "when I look at my profile, I should see my profile, how other
// people see it - and then edit, where applicable". From the top: your banner (change it here), the hero exactly as
// other members are shown it (your card from GET /people/me/card, drawn by the Human Profile's own frame), your
// company, then what only you see, the two ways to edit, and a nudge to add LinkedIn while there is none.
// The form that used to live here is at /profile/edit.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import OnboardingWelcomeModal from '@/features/onboarding/OnboardingWelcomeModal';
import { useOnboardingV2State } from '@/features/onboarding/useOnboardingV2';
import { cn } from '@/lib/utils';
import ReasonSheep from '../brand/ReasonSheep';
import { DarkPanel, HeroFrame, NoteBox, Offer } from '../human/ProfileHero';
import { personFacts } from '../human/profile-text';
import { errorMessage, fetchMyCard, reasonKeys } from '../api';
import ProfileEntities from '../entities/ProfileEntities';
import BannerEditor from './BannerEditor';
import {
  CONNECT_LINKEDIN_TO, EDIT_ANSWERS_TO, EDIT_PROFILE_TO, needsLinkedin, privateRows, youCanBring,
} from './your-profile-text';

const PAGE = 'mx-auto grid w-full max-w-[1284px] gap-[11px] md:gap-[18px]';
const BODY = 'text-[14px] leading-relaxed text-[#505762] [overflow-wrap:anywhere]';
const PRIMARY = 'flex min-h-[44px] items-center justify-center rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white hover:bg-reason-red-hover';
const QUIET = 'flex min-h-[44px] items-center justify-center rounded-[11px] border border-reason-line bg-white px-4 text-[14px] font-bold hover:bg-reason-soft';
const LOAD_HINT = 'Try again in a moment.';
const ANSWER = 'mt-1.5 text-[14px] leading-relaxed [overflow-wrap:anywhere]';

function Loading() {
  return (
    <div className={PAGE} aria-busy="true">
      <span className="sr-only" role="status">Loading your profile</span>
      <Skeleton className="aspect-[3/1] max-h-[260px] w-full rounded-[21px] md:rounded-[26px]" />
      <Skeleton className="h-[40vh] rounded-[21px] border border-reason-line bg-white" />
    </div>
  );
}

export default function YourProfilePage() {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  // Your card, exactly what other members are shown of you, and your answers, which only you are shown (the
  // onboarding's own state, the one screen 7 reads). A change to either (a save on the form, a new banner, a changed
  // answer, on any of your devices) is user:<you>, so both follow it.
  const card = useQuery({
    queryKey: reasonKeys.myCard,
    queryFn: fetchMyCard,
    enabled: !!me,
    meta: { entities: me ? [E.user(me)] : [] },
  });
  const answers = useOnboardingV2State();

  if (!card.data) {
    if (!card.isError) return <Loading />;
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
        <ReasonSheep pose="thinking" className="h-24 w-24" />
        <h1 className="text-[20px] font-bold">We could not load your profile just now.</h1>
        <p className="text-[14px] text-[#646a77]">{errorMessage(card.error, LOAD_HINT)}</p>
        <button type="button" onClick={() => void card.refetch()} className={cn(PRIMARY, 'mt-2')}>Try again</button>
      </div>
    );
  }

  const who = personFacts(card.data);
  const bring = youCanBring(card.data);
  return (
    <div className={PAGE}>
      <OnboardingWelcomeModal />
      <BannerEditor bannerUrl={card.data.bannerUrl} />

      <HeroFrame
        fit="shell"
        photo={card.data.avatarUrl}
        who={who}
        kicker="Your profile, as others see it"
        note={<NoteBox title="This is what members see" line="Who you want to meet and what you are hoping to find stay private. Only you see them, below." />}
        panel={(
          <DarkPanel fit="shell" kicker="What you can bring" title={bring ? 'Members read what you can bring.' : 'Say what you can bring.'}>
            <p className="mt-3.5 text-[14px] leading-relaxed text-[#d4d6da] [overflow-wrap:anywhere]">
              {bring
                ? 'On your profile it sits next to the reason REASON gives each member for meeting you.'
                : 'You have not said what you can bring yet. It is one of the first things members read about you.'}
            </p>
            {/* The very box other members read it in, on your Human Profile. */}
            {bring && (
              <div className="mt-[18px] grid gap-2.5 md:mt-auto md:pt-[22px]">
                <Offer label="They can bring" text={bring} />
              </div>
            )}
          </DarkPanel>
        )}
      />

      {/* Side by side, each card keeps its own height: stretched, the short company card was a blank box beside the answers. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-[11px] min-[981px]:grid-cols-2 min-[981px]:items-start min-[981px]:gap-[18px]">
        <ProfileEntities />

        <section className="min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:rounded-[24px] md:p-6" aria-labelledby="only-you">
          <p className="text-[11px] font-extrabold uppercase tracking-[0.11em]">Your answers</p>
          <h2 id="only-you" className="mt-3.5 text-[22px] font-bold tracking-[-0.035em] md:text-[24px]">Only you see this</h2>
          <p className={cn(BODY, 'mt-1.5')}>Other members never see these. REASON uses them to find the right people for you.</p>
          {answers.data ? (
            <dl className="mt-3.5 grid gap-2.5">
              {privateRows(answers.data).map((row) => (
                <div key={row.label} className="min-w-0 rounded-[14px] bg-reason-soft p-3.5">
                  <dt className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#646a77]">{row.label}</dt>
                  {row.lines.length ? row.lines.map((line, i) => (
                    <dd key={`${i}-${line}`} className={cn(ANSWER, 'text-reason-ink')}>{line}</dd>
                  )) : <dd className="mt-1.5 text-[14px] leading-relaxed text-[#646a77]">{row.empty}</dd>}
                </div>
              ))}
            </dl>
          ) : answers.isError ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-3">
              <p className={BODY}>{errorMessage(answers.error, 'We could not load your answers just now.')}</p>
              <button type="button" onClick={() => void answers.refetch()} className={QUIET}>Try again</button>
            </div>
          ) : (
            <div className="mt-3.5 grid gap-2.5" aria-busy="true">
              <Skeleton className="h-[68px] rounded-[14px]" />
              <Skeleton className="h-[68px] rounded-[14px]" />
              <Skeleton className="h-[68px] rounded-[14px]" />
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-wrap gap-2.5">
        <Link to={EDIT_PROFILE_TO} className={PRIMARY}>Edit profile</Link>
        <Link to={EDIT_ANSWERS_TO} className={QUIET}>Edit answers</Link>
      </div>

      {needsLinkedin(card.data) && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[19px] border border-[#cfe0f5] bg-[#f3f8fd] p-[17px] md:rounded-[24px] md:p-6">
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold [overflow-wrap:anywhere]">Optimize your profile: connect LinkedIn</h2>
            <p className="mt-1 text-[13px] text-[#505762]">Add your LinkedIn profile so members can learn more about you.</p>
          </div>
          <Link to={CONNECT_LINKEDIN_TO} className="flex min-h-[44px] items-center rounded-[11px] bg-[#0a66c2] px-4 text-[14px] font-bold text-white hover:bg-[#004182]">Add LinkedIn</Link>
        </section>
      )}
    </div>
  );
}
