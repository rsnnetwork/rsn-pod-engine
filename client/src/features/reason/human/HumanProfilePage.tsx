// client/src/features/reason/human/HumanProfilePage.tsx
// Stefan's v4 "live relationship brief": full screen, its own header, and a
// bar at the bottom that always offers one useful move.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { primaryActionFor, type PersonBrief } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import ReasonMark from '../brand/ReasonMark';
import ReasonSheep from '../brand/ReasonSheep';
import ProfileHero from './ProfileHero';
import ProfileDetails from './ProfileDetails';
import MoveBar from './MoveBar';
import MeetSheet from './MeetSheet';
import OutcomeSheet from './OutcomeSheet';
import { STATE_LABEL } from './labels';
import {
  MOVE_RESPONSE, isMemberId, knownSource, moveToast, personFacts, shouldRetry, statusOf, viewFor, type KnownSource, type Move,
} from './profile-text';
import { errorMessage, fetchBrief, reasonKeys, setPersonResponse } from '../api';

// The line under "could not load" when the failure itself has nothing more specific to say.
const LOAD_HINT = 'Try again in a moment.';

// Side margins that also keep clear of the notch when a phone is on its side.
const SIDES = 'pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] md:pl-[max(22px,env(safe-area-inset-left))] md:pr-[max(22px,env(safe-area-inset-right))]';
const MAIN = 'mx-auto w-full max-w-[1264px] md:max-w-[1284px]';
const PRIMARY_BUTTON = 'min-h-[44px] rounded-[11px] bg-reason-red px-4 font-bold text-white enabled:hover:bg-reason-red-hover';
const QUIET_BUTTON = 'min-h-[44px] rounded-[11px] border border-reason-line bg-white px-4 font-bold';

function Loading() {
  return (
    <main className={cn(MAIN, SIDES, 'grid gap-3 py-4')} aria-busy="true">
      <span className="sr-only" role="status">Loading this profile</span>
      <Skeleton className="h-[40vh] rounded-[21px] border border-reason-line bg-white" />
      <Skeleton className="h-40 rounded-[21px] border border-reason-line bg-white" />
    </main>
  );
}

// The sheep is only drawn when the server answered: with the connection gone the picture cannot load either,
// and a broken-image box would sit where it should be.
function Notice({ title, text, sheep = true, children }: { title: string; text: string; sheep?: boolean; children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      {sheep && <ReasonSheep pose="thinking" className="h-24 w-24" />}
      <h1 className="text-[20px] font-bold">{title}</h1>
      <p className="text-[14px] text-[#646a77]">{text}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2.5">{children}</div>
    </main>
  );
}

// The profile itself, once the brief is in. Keyed by the person in the page, so Save, Pass and the two
// sheets start fresh when one profile opens another (the "Your path" link).
function Profile({ brief, userId, source }: { brief: PersonBrief; userId: string; source: KnownSource | null }) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const [meetOpen, setMeetOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const who = personFacts(brief.person);
  const r = brief.relationship;
  // A sheet gets the same object until the person really changes. A fresh one on every render (a realtime
  // refetch is one) would look like a new person to the sheet, and could reset a note being typed.
  const meetPerson = useMemo(() => (meetOpen ? { userId, displayName: who.name } : null), [meetOpen, userId, who.name]);
  const outcomePerson = useMemo(() => (outcomeOpen ? { userId, displayName: who.name } : null), [outcomeOpen, userId, who.name]);

  // A profile opened from another one (the "Your path" link) starts at its top, not where the last one was
  // scrolled to. The app scrolls smoothly (index.css); this one jump must not.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, []);

  // networkMode 'always': offline, a press fails at once and says so ("Connection lost..."). By default the
  // library parks the request until the connection returns, and the press would never answer.
  const respond = useMutation({
    networkMode: 'always',
    mutationFn: (move: Move) => setPersonResponse(userId, MOVE_RESPONSE[move]),
    onSuccess: (_result, move) => {
      const { message, type } = moveToast(move, who.first);
      addToast(message, type);
      // Returned, so the buttons stay busy until the fresh brief is in and the star has changed.
      return qc.invalidateQueries({ queryKey: reasonKeys.all });
    },
    onError: (err) => {
      addToast(errorMessage(err, 'Could not update that right now.'), 'error');
      // A 404 means the person is gone: let the page find out, so it says so instead of leaving live buttons.
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: reasonKeys.brief(userId) }) : undefined;
    },
  });
  // The buttons are only busy a moment after a press, so a quick second tap would repeat the request and its
  // toast. One press at a time.
  const pressing = useRef(false);
  const press = (move: Move) => {
    if (pressing.current) return;
    pressing.current = true;
    respond.mutate(move, { onSettled: () => { pressing.current = false; } });
  };

  const onPrimary = () => {
    const action = primaryActionFor(r.state);
    if (action === 'meet') setMeetOpen(true);
    else if (action === 'continue') navigate(`/messages/new/${userId}`);
    else if (action === 'respond') navigate(r.pokeId ? `/messages?poke=${r.pokeId}` : '/messages');
  };

  return (
    <>
      <main className={cn(MAIN, SIDES, 'pb-[calc(116px+env(safe-area-inset-bottom))] pt-3 md:pt-6')}>
        <ProfileHero brief={brief} who={who} source={source} />
        <ProfileDetails brief={brief} who={who} source={source} onRecordOutcome={() => setOutcomeOpen(true)} />
      </main>
      <MoveBar
        brief={brief}
        busy={respond.isPending}
        onPrimary={onPrimary}
        onToggleSave={() => press(r.saved ? 'unsave' : 'save')}
        onTogglePass={() => press(r.passed ? 'unpass' : 'pass')}
      />
      <MeetSheet person={meetPerson} onClose={() => setMeetOpen(false)} />
      <OutcomeSheet person={outcomePerson} onClose={() => setOutcomeOpen(false)} />
    </>
  );
}

export default function HumanProfilePage() {
  const { userId: param = '' } = useParams();
  // The server reads an id in any case as the same member; so does the page (one cache entry, and your own id
  // in capitals still goes to your profile).
  const userId = param.toLowerCase();
  const validId = isMemberId(userId);
  const [params] = useSearchParams();
  const source = knownSource(params.get('from'));
  const location = useLocation();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user?.id as string | undefined);

  const { data: brief, error, fetchStatus, isError, isPending, refetch } = useQuery({
    queryKey: reasonKeys.brief(userId),
    queryFn: () => fetchBrief(userId),
    // An address that is no member id (a typo, a crafted link) is answered without asking the server.
    enabled: validId && !!me && userId !== me,
    // A 4xx is an answer, so asking again changes nothing; a lost connection or a 5xx gets one more try.
    retry: shouldRetry,
    meta: { entities: me && userId ? [E.user(me), E.user(userId), E.userInvites(me), E.userDms(me)] : [] },
  });

  if (me && userId === me) return <Navigate to="/profile" replace />;

  // The first screen of the app in this tab (a link opened from an email, say): going back would leave
  // the app, so go to For You instead. `replace` keeps the browser's own Back button from returning here.
  const back = () => {
    if (location.key === 'default') navigate('/', { replace: true });
    else navigate(-1);
  };
  // Which screen: see viewFor. In short, a profile already on screen stays through a failed or held-back
  // refetch, and only "this person is gone" replaces it.
  const view = viewFor({ hasBrief: !!brief, validId, isPending, isError, error, fetchStatus });

  return (
    <div className="min-h-[100dvh] bg-[#f6f5f3] font-reason text-reason-ink antialiased">
      <header className="sticky top-0 z-[5] flex h-[calc(60px+env(safe-area-inset-top))] items-center justify-between gap-3 border-b border-reason-line bg-white/95 pl-[max(11px,env(safe-area-inset-left))] pr-[max(11px,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur-lg md:h-[calc(70px+env(safe-area-inset-top))] md:pl-[max(24px,env(safe-area-inset-left))] md:pr-[max(24px,env(safe-area-inset-right))]">
        <div className="flex items-center gap-2.5">
          <button type="button" onClick={back} className="min-h-[44px] rounded-full border border-reason-line bg-white px-3.5 text-[13px] font-extrabold">← Back</button>
          <span className="hidden sm:inline"><ReasonMark variant="mobile" /></span>
        </div>
        {view === 'profile' && brief && (
          <span className="rounded-full bg-[#f2f3f5] px-2.5 py-1.5 text-[10px] font-extrabold text-[#555d69]">{STATE_LABEL[brief.relationship.state]}</span>
        )}
      </header>

      {view === 'profile' && brief ? (
        <Profile key={userId} brief={brief} userId={userId} source={source} />
      ) : view === 'loading' ? (
        <Loading />
      ) : view === 'unavailable' ? (
        <Notice title="This profile is not available." text="It may have been closed, or it is not open to you.">
          <button type="button" onClick={back} className={PRIMARY_BUTTON}>Go back</button>
        </Notice>
      ) : (
        // No error at all means the library is holding the request back because the browser is offline, and
        // errorMessage then says the connection was lost. When it returns, the request goes out by itself.
        <Notice title="We could not load this profile just now." text={errorMessage(error, LOAD_HINT)} sheep={statusOf(error) !== undefined}>
          <button type="button" onClick={() => void refetch()} className={PRIMARY_BUTTON}>Try again</button>
          <button type="button" onClick={back} className={QUIET_BUTTON}>Go back</button>
        </Notice>
      )}
    </div>
  );
}
