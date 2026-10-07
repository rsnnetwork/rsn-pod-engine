// client/src/features/reason/for-you/ForYouPage.tsx
// "Who matters to me right now, and why?" A tight shortlist (max 5), never a
// directory (Stefan's v4: do not merge For You and People).
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import OnboardingWelcomeModal from '@/features/onboarding/OnboardingWelcomeModal';
import PageHead from '../ui/PageHead';
import ReasonSheep from '../brand/ReasonSheep';
import HumanCard, { type HumanCardPerson } from '../human/HumanCard';
import MeetSheet from '../human/MeetSheet';
import { statusOf } from '../human/profile-text';
import ForYouRail from './ForYouRail';
import ForYouEmpty from './ForYouEmpty';
import { errorMessage, fetchForYou, personName, reasonKeys, setPersonResponse, stateFromPoke, type ForYouMatch } from '../api';
import { CONNECTION_LOST } from '../errors';
import { visibleText } from '../person';

const SHORTLIST = 5;
// Every Save carries this key, so the page can ask which people have a Save in flight.
const SAVE_KEY = ['reason', 'save-person'] as const;

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
  const section = useRef<HTMLElement>(null);
  const retrying = useRef(false);
  // The people a Save is out for. A ref, not the card's busy flag: that is drawn a render after the first press, so a
  // near-instant double click reached the handler twice and sent two requests (and said "saved" twice).
  const inFlight = useRef(new Set<string>());

  // "Still loading" is isPending: a fetch that is paused (the member is offline) is not loading and has
  // no data either, and must not read as "no one to suggest".
  const { data, isPending, isError, fetchStatus, refetch } = useQuery({
    queryKey: reasonKeys.forYou,
    queryFn: fetchForYou,
    enabled: !!userId,
    // The next event follows pod membership, so a pod change refreshes this page too.
    meta: { entities: userId ? [E.user(userId), E.userInvites(userId), E.userDms(userId), E.userPods(userId)] : [] },
  });
  // Offline with nothing to show yet: the request exists and waits for the connection. A skeleton would never
  // tell the member why, so the error says it; the request resumes by itself when the connection returns. The
  // sentence under the heading follows fetchStatus alone, so it is there too when "Try again" is held back.
  const waitingForConnection = isPending && fetchStatus === 'paused';
  // The error replaces the page only when there is nothing else to show: a refresh that fails while a list
  // is on screen (a Save's, a window coming back to the front) leaves the list as it is.
  const cannotLoad = data === undefined && (isError || waitingForConnection);

  // "Try again" is gone from under the member's finger as soon as the request starts (the error becomes a
  // skeleton). When the answer is in, focus goes to the section's heading, so the keyboard is not left nowhere.
  const tryAgain = () => { retrying.current = true; void refetch(); };
  useEffect(() => {
    if (isPending || !retrying.current) return;
    retrying.current = false;
    section.current?.querySelector<HTMLElement>('#foryou-title')?.focus();
  }, [isPending, isError]);

  const save = useMutation({
    mutationKey: SAVE_KEY,
    // With no connection a Save fails at once with the connection sentence, instead of waiting behind a card
    // that looks busy until the network comes back.
    networkMode: 'always',
    mutationFn: (p: HumanCardPerson) => setPersonResponse(p.userId, p.saved ? null : 'saved'),
    onSuccess: async (_r, p) => {
      addToast(p.saved ? `${p.displayName} removed from saved` : `${p.displayName} saved`, 'success');
      // Everything REASON has cached is stale now, so a profile opened later shows the new state...
      await qc.invalidateQueries({ queryKey: reasonKeys.all, refetchType: 'none' });
      // ...but only the list in front of the member is fetched again, and waited for: the card stays busy until it shows its new state.
      await qc.invalidateQueries({ queryKey: reasonKeys.forYou });
    },
    onError: (err) => {
      addToast(errorMessage(err, 'Could not save that right now. Try again in a moment.'), 'error');
      // A 404 means the person is gone: fetch the list again, so their card goes instead of staying with live buttons.
      // Returned, so the card stays busy until the list is in.
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: reasonKeys.forYou }) : undefined;
    },
    // Given back on the mutation itself, not on a .mutate() call: those callbacks are dropped once a later press (for
    // another card) takes the observer over, which would leave the first card stuck for good.
    onSettled: (_data, _error, p) => { inFlight.current.delete(p.userId); },
  });
  const toggleSave = (p: HumanCardPerson) => {
    if (inFlight.current.has(p.userId)) return;
    inFlight.current.add(p.userId);
    save.mutate(p);
  };
  // One useMutation only tracks its latest call, so each card's busy comes from every Save in flight instead.
  const saving = useMutationState({
    filters: { mutationKey: SAVE_KEY, status: 'pending' },
    select: (m) => (m.state.variables as HumanCardPerson).userId,
  });

  const firstName = String(user?.firstName || user?.displayName || '').split(' ')[0];
  const cards = (data?.matches ?? []).slice(0, SHORTLIST).map((m) => toCard(m, data?.youAreLookingFor ?? null));

  return (
    <>
      <OnboardingWelcomeModal />
      <PageHead eyebrow="GOOD TO SEE YOU" title={firstName ? `Welcome, ${firstName}.` : 'Welcome.'} subtitle="Here are people you have a reason to meet." pose="match" />
      <div className="grid items-start gap-3 min-[981px]:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] min-[981px]:gap-[18px]">
        <section ref={section} aria-labelledby="foryou-title" className="min-w-0 rounded-[15px] border border-reason-line bg-white p-[13px] shadow-[0_6px_24px_rgba(16,18,24,.025)] min-[721px]:rounded-[18px] min-[721px]:p-[18px]">
          {cannotLoad ? (
            <div role="alert" className="flex flex-col items-start gap-3 py-4">
              <div>
                <h2 id="foryou-title" tabIndex={-1} className="text-[15px] font-bold outline-none">We could not load your people just now.</h2>
                {fetchStatus === 'paused' && <p className="mt-1 text-[13px] text-reason-muted">{CONNECTION_LOST}</p>}
              </div>
              <button type="button" onClick={tryAgain} className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white hover:bg-reason-red-hover">Try again</button>
            </div>
          ) : isPending ? (
            <div className="grid gap-3.5" aria-busy="true">
              <h2 id="foryou-title" className="sr-only">Loading your people</h2>
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[150px]" />)}
            </div>
          ) : cards.length === 0 ? (
            <ForYouEmpty profileIncomplete={!!data?.profileIncomplete} nextEvent={data?.nextEvent ?? null} />
          ) : (
            <>
              <div className="mb-3 flex items-start justify-between gap-2 min-[721px]:mb-3.5">
                <div className="flex min-w-0 items-start gap-2 min-[721px]:items-center min-[721px]:gap-2.5">
                  <ReasonSheep pose="match" className="h-9 w-9 shrink-0 min-[721px]:h-[42px] min-[721px]:w-[42px]" />
                  <div className="min-w-0">
                    <h2 id="foryou-title" tabIndex={-1} className="text-[18px] font-bold leading-[1.12] tracking-[-0.025em] outline-none min-[721px]:text-[22px]">
                      {cards.length === 1 ? '1 person you have a reason to meet' : `${cards.length} people you have a reason to meet`}
                    </h2>
                    <small className="mt-[3px] block text-[11px] leading-[1.35] text-reason-muted min-[721px]:mt-1 min-[721px]:text-[13px]">
                      Based on your current reasons, network and upcoming contexts.
                    </small>
                  </div>
                </div>
                <Link to="/matches" aria-label="View all people" className="flex min-h-[44px] shrink-0 items-center px-1 text-[12px] text-[#575f6f] hover:text-reason-red">View all</Link>
              </div>
              <div className="grid gap-3.5">
                {cards.map((p) => (
                  <HumanCard
                    key={p.userId}
                    person={p}
                    source="For You"
                    busy={saving.includes(p.userId)}
                    onMeet={setMeeting}
                    onToggleSave={toggleSave}
                  />
                ))}
              </div>
            </>
          )}
        </section>
        <ForYouRail nextEvent={data?.nextEvent} failed={cannotLoad} />
      </div>
      <MeetSheet person={meeting} onClose={() => setMeeting(null)} />
    </>
  );
}
