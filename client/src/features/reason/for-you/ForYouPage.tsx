// client/src/features/reason/for-you/ForYouPage.tsx
// "Who matters to me right now, and why?" A tight shortlist (max 5), never a
// directory (Stefan's v4: do not merge For You and People).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import OnboardingWelcomeModal from '@/features/onboarding/OnboardingWelcomeModal';
import PageHead from '../ui/PageHead';
import ReasonSheep from '../brand/ReasonSheep';
import HumanCard, { type HumanCardPerson } from '../human/HumanCard';
import MeetSheet from '../human/MeetSheet';
import ForYouRail from './ForYouRail';
import ForYouEmpty from './ForYouEmpty';
import { errorMessage, fetchForYou, personName, reasonKeys, setPersonResponse, stateFromPoke, type ForYouMatch } from '../api';
import { visibleText } from '../person';

const SHORTLIST = 5;

function toCard(m: ForYouMatch, youAreLookingFor: string | null): HumanCardPerson {
  const industry = visibleText(m.industry);
  return {
    userId: m.userId,
    displayName: personName(m.displayName),
    avatarUrl: m.avatarUrl,
    role: m.professionalRole,
    company: m.company,
    tags: industry ? [industry] : [],
    reason: m.reason,
    theyCanBring: m.theyCanBring,
    youAreLookingFor,
    state: stateFromPoke(m.pokeStatus, m.pokeSentByOwner),
    saved: m.saved,
  };
}

export default function ForYouPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id as string | undefined;
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const [meeting, setMeeting] = useState<HumanCardPerson | null>(null);

  // "Still loading" is isPending: a fetch that is paused (the member is offline) is not loading and has
  // no data either, and must not read as "no one to suggest".
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: reasonKeys.forYou,
    queryFn: fetchForYou,
    enabled: !!userId,
    // The next event follows pod membership, so a pod change refreshes this page too.
    meta: { entities: userId ? [E.user(userId), E.userInvites(userId), E.userDms(userId), E.userPods(userId)] : [] },
  });

  const save = useMutation({
    mutationFn: (p: HumanCardPerson) => setPersonResponse(p.userId, p.saved ? null : 'saved'),
    // The invalidation is returned, so the card stays busy until the fresh list shows its new state.
    onSuccess: (_r, p) => {
      addToast(p.saved ? `${p.displayName} removed from saved` : `${p.displayName} saved`, 'success');
      return qc.invalidateQueries({ queryKey: reasonKeys.all });
    },
    onError: (err) => addToast(errorMessage(err, 'Could not save that right now. Try again in a moment.'), 'error'),
  });

  const firstName = String(user?.firstName || user?.displayName || '').split(' ')[0];
  const cards = (data?.matches ?? []).slice(0, SHORTLIST).map((m) => toCard(m, data?.youAreLookingFor ?? null));

  return (
    <>
      <OnboardingWelcomeModal />
      <PageHead eyebrow="GOOD TO SEE YOU" title={firstName ? `Welcome, ${firstName}.` : 'Welcome.'} subtitle="Here are people you have a reason to meet." pose="match" />
      <div className="grid items-start gap-3 min-[981px]:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] min-[981px]:gap-[18px]">
        <section aria-labelledby="foryou-title" className="min-w-0 rounded-[15px] border border-reason-line bg-white p-[13px] shadow-[0_6px_24px_rgba(16,18,24,.025)] min-[721px]:rounded-[18px] min-[721px]:p-[18px]">
          {isPending ? (
            <div className="grid gap-3.5" aria-busy="true">
              <h2 id="foryou-title" className="sr-only">Loading your people</h2>
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[150px]" />)}
            </div>
          ) : isError ? (
            <div role="alert" className="flex flex-col items-start gap-3 py-4">
              <h2 id="foryou-title" className="text-[15px] font-bold">We could not load your people just now.</h2>
              <button type="button" onClick={() => refetch()} className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white hover:bg-reason-red-hover">Try again</button>
            </div>
          ) : cards.length === 0 ? (
            <ForYouEmpty profileIncomplete={!!data?.profileIncomplete} nextEvent={data?.nextEvent ?? null} />
          ) : (
            <>
              <div className="mb-3 flex items-start justify-between gap-2 min-[721px]:mb-3.5">
                <div className="flex min-w-0 items-start gap-2 min-[721px]:items-center min-[721px]:gap-2.5">
                  <ReasonSheep pose="match" className="h-9 w-9 shrink-0 min-[721px]:h-[42px] min-[721px]:w-[42px]" />
                  <div className="min-w-0">
                    <h2 id="foryou-title" className="text-[18px] font-bold leading-[1.12] tracking-[-0.025em] min-[721px]:text-[22px]">
                      {cards.length === 1 ? '1 person you have a reason to meet' : `${cards.length} people you have a reason to meet`}
                    </h2>
                    <small className="mt-[3px] block text-[11px] leading-[1.35] text-reason-muted min-[721px]:mt-1 min-[721px]:text-[13px]">
                      Based on your current reasons, network and upcoming contexts.
                    </small>
                  </div>
                </div>
                <Link to="/matches" className="flex min-h-[44px] shrink-0 items-center px-1 text-[12px] text-[#575f6f] hover:text-reason-red">View all</Link>
              </div>
              <div className="grid gap-3.5">
                {cards.map((p) => (
                  <HumanCard
                    key={p.userId}
                    person={p}
                    source="For You"
                    busy={save.isPending && save.variables?.userId === p.userId}
                    onMeet={setMeeting}
                    onToggleSave={(x) => save.mutate(x)}
                  />
                ))}
              </div>
            </>
          )}
        </section>
        <ForYouRail nextEvent={data?.nextEvent} failed={isError} />
      </div>
      <MeetSheet person={meeting} onClose={() => setMeeting(null)} />
    </>
  );
}
