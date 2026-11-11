// ─── An event's RSN Call link: /call/<code> (Part 2, Task 12; spec 02, 04, 12/01-05) ──────────────────────────
//
// Design-review prototype 1, "open speed networking entry without onboarding". Anyone holding the link opens it and sees
// the event; signed out they give an email, type the 6-digit code from it, give only what this event still needs (a name,
// a group, an admission code), and go straight in: into the live room when the event is live, else onto "You're in". A
// signed-in member skips the email and the code; the email's own button (?entry=<token>) skips them too. Platform
// onboarding is never on this path, for a member or a guest: this page sits outside the protected routes, and the live
// room is exempt from the onboarding gate.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import ToastContainer from '@/components/ui/Toast';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import {
  CALL_WORDS, admissionRefusalOf, callScreenOf, detailsFieldsFor, enterFailure, landingFailure, progressIndexOf,
  refusalSentence, tokenFailureMessage, verifyFailure, type AdmissionRefusal, type CallScreen, type EntryFailure,
  type IdentifyPhase,
} from './call-entry';
import CallFrame from './CallFrame';
import CallEventSummary from './CallEventSummary';
import CallEmailStep from './CallEmailStep';
import CallCodeStep from './CallCodeStep';
import CallDetailsStep, { type DetailsAnswer } from './CallDetailsStep';
import CallWaitingStep from './CallWaitingStep';
import CallNotice from './CallNotice';
import { GUEST_HOME_PATH, isEventGuest, rememberCallLink } from './guest-routes';
import { useCallActions, useCallLink } from './useCallLink';

type Closed = NonNullable<EntryFailure['closed']>;

/** Marks the live room as reached from this page: a refusal there is shown, not sent back here (no loop). */
const FROM_CALL_LINK = { fromCallLink: true } as const;

function Loading() {
  return (
    <CallFrame progress={null}>
      <div className="space-y-4" aria-busy="true" aria-label="Loading the event">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-9 w-4/5" />
        <Skeleton className="h-5 w-3/5" />
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="mt-6 h-12 w-full rounded-2xl" />
      </div>
    </CallFrame>
  );
}

export default function CallLinkPage() {
  const { code = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { landing, entry, userId, checked } = useCallLink(code);
  const { sendCode, verify, enter, leaveWaitlist } = useCallActions(code);
  const addToast = useToastStore((s) => s.addToast);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const guest = isEventGuest(user);

  const [phase, setPhase] = useState<IdentifyPhase>('summary');
  const [started, setStarted] = useState(false);
  const [email, setEmail] = useState('');
  const [admissionCode, setAdmissionCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [closed, setClosed] = useState<Closed | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [autoTried, setAutoTried] = useState(false);
  // The event's answer to an admission code this page sent by itself: said above the field that then asks for one.
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const dropCarried = (message: string) => {
    setAdmissionCode('');
    setAdmissionError(message);
    setAutoTried(false);
  };
  const tokenTried = useRef(false);
  const [tokenPending, setTokenPending] = useState(false);
  // The email's button, proved but refused by the event: the code step asks for the admission code and sends it again.
  const [tokenRefused, setTokenRefused] = useState<{ token: string; refusal: AdmissionRefusal } | null>(null);

  // The email's own button: ?entry=<token> proves the address by itself. Taken off the address bar at once, so a
  // reload or a shared screenshot never carries it.
  const entryToken = params.get('entry');
  useEffect(() => {
    if (!checked || !entryToken || tokenTried.current) return;
    tokenTried.current = true;
    const rest = new URLSearchParams(params);
    rest.delete('entry');
    setParams(rest, { replace: true });
    setTokenPending(true);
    verify.mutateAsync({ token: entryToken })
      .then(() => setStarted(true))
      .catch((err) => {
        const refusal = admissionRefusalOf(err);
        if (refusal) {
          setTokenRefused({ token: entryToken, refusal });
          setPhase('code');
          return;
        }
        const said = verifyFailure(err);
        if (said.closed) {
          setClosed(said.closed);
          return;
        }
        setLinkNotice(tokenFailureMessage(err));
        setPhase('email');
      })
      .finally(() => setTokenPending(false));
    // Once per page: the token is gone from the address after the first pass.
  }, [checked, entryToken, params, setParams, verify]);

  // The admission code given on this page (beside the email, or after the code) is not asked for again: it goes with the
  // entry by itself. Only if the event does not take it is the field shown again, with the event's answer.
  const carried = admissionCode.trim();
  const raw = userId ? entry.data ?? null : null;
  const carryCode = !!raw && !!carried && raw.missing.admissionCode;
  const state = raw && carryCode ? { ...raw, missing: { ...raw.missing, admissionCode: false }, refusal: null } : raw;
  const screen: CallScreen | null = landing.data
    ? closed === 'ended' ? 'ended' : closed === 'cancelled' ? 'cancelled'
      : callScreenOf({ landing: landing.data, entry: state, phase, started })
    : null;

  // In: straight to the live room, writing down which link led there (a guest the room refuses comes back here).
  const livePath = state?.step === 'enter' ? state.livePath : null;
  useEffect(() => {
    if (screen !== 'live' || !livePath) return;
    if (state?.sessionId) rememberCallLink(state.sessionId, code);
    navigate(livePath, { replace: true, state: FROM_CALL_LINK });
  }, [screen, livePath, state?.sessionId, code, navigate]);

  // Nothing missing once they asked: enter at once (once; a second try is their own press).
  useEffect(() => {
    if (screen !== 'joining' || autoTried || enter.isPending) return;
    setAutoTried(true);
    setJoinError(null);
    enter.mutateAsync(carryCode ? { admissionCode: carried } : {}).catch((err) => {
      const said = enterFailure(err);
      if (said.closed) setClosed(said.closed);
      else if (said.field === 'admissionCode' && carryCode) dropCarried(said.message);
      else setJoinError(said.message);
    });
  }, [screen, autoTried, enter, carryCode, carried]);

  if (!checked || landing.isPending || (userId && landing.isSuccess && entry.isPending) || tokenPending) {
    return <Loading />;
  }

  const lost = closed === 'not_found'
    || (landing.isError && landingFailure(landing.error) === 'not_found')
    || (entry.isError && landingFailure(entry.error) === 'not_found');
  if (lost) {
    return (
      <CallFrame progress={null}>
        <CallNotice tone="info" title={CALL_WORDS.notFound} detail={CALL_WORDS.notFoundMore} testId="call-not-found">
          <Button variant="secondary" size="lg" className="w-full rounded-2xl" onClick={() => navigate(userId ? (guest ? GUEST_HOME_PATH : '/sessions') : '/login')}>
            {userId ? (guest ? 'Your events' : 'Your events on REASON') : 'Go to REASON'}
          </Button>
        </CallNotice>
      </CallFrame>
    );
  }
  if (!landing.data || !screen || (userId && entry.isError)) {
    return (
      <CallFrame progress={null}>
        <CallNotice tone="info" title={CALL_WORDS.loadFailed} testId="call-unavailable">
          <Button size="lg" className="w-full rounded-2xl" onClick={() => { void landing.refetch(); if (userId) void entry.refetch(); }}>
            Try again
          </Button>
        </CallNotice>
      </CallFrame>
    );
  }

  const event = landing.data;
  const homePath = guest ? GUEST_HOME_PATH : '/sessions';
  const homeButton = userId ? (
    <Button variant="secondary" size="lg" className="w-full rounded-2xl" onClick={() => navigate(homePath)}>
      {guest ? 'Your events' : 'Your events on REASON'}
    </Button>
  ) : (
    <Button variant="secondary" size="lg" className="w-full rounded-2xl" onClick={() => navigate('/login')}>Go to REASON</Button>
  );
  const finalScreen = ['ended', 'cancelled', 'refused', 'declined'].includes(screen);
  const progress = finalScreen ? null : progressIndexOf(screen);
  const approval = state?.step === 'request' || event.admission === 'approval';

  const sendTheCode = async (input: { email: string; admissionCode?: string }) => {
    const sent = await sendCode.mutateAsync(input);
    setEmail(input.email);
    setAdmissionCode(input.admissionCode ?? '');
    setDevCode(sent.devCode ?? null);
    setLinkNotice(null);
    setTokenRefused(null);
    setPhase('code');
  };

  const giveDetails = async (answer: DetailsAnswer) => {
    let now;
    try {
      now = await enter.mutateAsync(carryCode && !answer.admissionCode ? { ...answer, admissionCode: carried } : answer);
    } catch (err) {
      const said = enterFailure(err);
      if (said.field === 'admissionCode' && carryCode) dropCarried(said.message);
      throw err;
    }
    if (now.step === 'enter' && now.livePath && now.sessionId) {
      rememberCallLink(now.sessionId, code);
      navigate(now.livePath, { replace: true, state: FROM_CALL_LINK });
    }
  };

  // Part 3 Task 8: off the line, and never back on it by itself. The leave's own refresh reads the entry again (details,
  // nothing missing) BEFORE mutateAsync resolves; with `started` still true that is the 'joining' screen, whose effect
  // entered at once and queued them again at the back (preview smoke, 11 Nov). So the page stops asking first: back to
  // the event's summary, the automatic enter spent, and only a fresh Join press (joinAgain) arms it again. A failed
  // leave still shows the waiting-list screen, which follows the server's step, not `started`.
  const leaveTheLine = async () => {
    setStarted(false);
    setAutoTried(true);
    try {
      await leaveWaitlist.mutateAsync();
      setJoinError(null);
      addToast(CALL_WORDS.leftWaitlist, 'info');
    } catch (err) {
      const said = enterFailure(err);
      if (said.closed) setClosed(said.closed);
      else addToast(CALL_WORDS.leaveWaitlistFailed, 'error');
    }
  };

  /** The summary's Join, pressed: the only way back into the event (and, when it is full, onto its line). */
  const joinAgain = () => {
    setAutoTried(false);
    setStarted(true);
  };

  const signOut = async () => {
    await logout();
    setStarted(false);
    setPhase('summary');
  };

  let body;
  switch (screen) {
    case 'summary':
      body = (
        <div className="space-y-6">
          <div className="lg:hidden"><CallEventSummary landing={event} /></div>
          <div className="space-y-3 lg:space-y-4">
            <h2 className="hidden text-[22px] font-extrabold leading-tight lg:block">Join this event</h2>
            <p className="hidden text-[15px] text-reason-muted lg:block">
              {userId ? 'You are signed in, so there is nothing to type.' : "Enter your email, type the code we send you, and you're in. No password, no profile."}
            </p>
            <Button
              size="lg"
              className="w-full rounded-2xl"
              onClick={() => (userId ? joinAgain() : setPhase('email'))}
              data-testid="call-join"
            >
              {userId ? (approval ? 'Ask to join' : 'Join this event') : 'Join with your email'}
              <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
            </Button>
            {userId && (
              <p className="text-center text-[13px] text-reason-muted lg:text-left">
                Signed in as <span className="font-semibold text-reason-ink">{user?.displayName || user?.email}</span>.{' '}
                <button type="button" onClick={() => void signOut()} className="inline-flex min-h-[44px] items-center font-semibold text-reason-ink underline underline-offset-2">
                  Not you?
                </button>
              </p>
            )}
          </div>
        </div>
      );
      break;
    case 'email':
      body = (
        <CallEmailStep
          asksAdmissionCode={event.asks.admissionCode}
          defaults={{ email, admissionCode }}
          notice={linkNotice}
          send={sendTheCode}
          onClosed={setClosed}
          onBack={() => setPhase('summary')}
        />
      );
      break;
    case 'code':
      body = (
        <CallCodeStep
          email={tokenRefused ? null : email}
          devCode={devCode}
          carriedAdmissionCode={admissionCode}
          initialRefusal={tokenRefused?.refusal ?? null}
          verify={async (typed, admission) => {
            const extra = admission ? { admissionCode: admission } : {};
            await verify.mutateAsync(typed === null && tokenRefused
              ? { token: tokenRefused.token, ...extra }
              : { email, code: typed ?? '', ...extra });
            if (admission) setAdmissionCode(admission);
            setStarted(true);
          }}
          resend={() => sendTheCode({ email, admissionCode: admissionCode || undefined })}
          onDifferentEmail={() => { setTokenRefused(null); setPhase('email'); }}
          onClosed={setClosed}
        />
      );
      break;
    case 'details':
      body = (
        <CallDetailsStep
          fields={detailsFieldsFor(state!.missing, event.asks.group)}
          refusal={admissionError ?? (state!.refusal ? refusalSentence(state!) : null)}
          approval={approval}
          defaults={{ admissionCode: '' }}
          submit={giveDetails}
          onClosed={setClosed}
        />
      );
      break;
    case 'joining':
    case 'live':
      body = joinError ? (
        <CallNotice tone="refused" title={joinError} testId="call-join-failed">
          <Button size="lg" className="w-full rounded-2xl" onClick={() => setAutoTried(false)}>Try again</Button>
        </CallNotice>
      ) : (
        <div className="flex flex-col items-center gap-3 py-8 text-center" role="status" data-testid="call-joining">
          <Loader2 aria-hidden="true" className="h-8 w-8 animate-spin text-reason-red" />
          <p className="text-[15px] font-semibold">{CALL_WORDS.joining}</p>
        </div>
      );
      break;
    case 'waiting':
    case 'pending':
      body = (
        <CallWaitingStep landing={event} kind={screen} sessionId={state?.sessionId ?? null} startsAt={state?.startsAt ?? event.scheduledAt} guest={guest} />
      );
      break;
    case 'waitlisted':
      body = (
        <CallWaitingStep
          landing={event}
          kind="waitlisted"
          sessionId={state?.sessionId ?? null}
          startsAt={state?.startsAt ?? event.scheduledAt}
          guest={guest}
          position={state?.waitlistPosition ?? null}
          onLeave={leaveTheLine}
          leaving={leaveWaitlist.isPending}
        />
      );
      break;
    case 'ended':
      body = <CallNotice tone="closed" title={CALL_WORDS.ended} testId="call-ended">{homeButton}</CallNotice>;
      break;
    case 'cancelled':
      body = <CallNotice tone="closed" title={CALL_WORDS.cancelled} testId="call-cancelled">{homeButton}</CallNotice>;
      break;
    case 'declined':
      body = <CallNotice tone="refused" title={CALL_WORDS.declined} testId="call-declined">{homeButton}</CallNotice>;
      break;
    default:
      body = <CallNotice tone="refused" title={refusalSentence(state!)} testId="call-refused">{homeButton}</CallNotice>;
  }

  return (
    <>
      <CallFrame progress={progress} aside={<CallEventSummary landing={event} />}>
        {screen !== 'summary' && <div className="lg:hidden"><CallEventSummary landing={event} variant="compact" /></div>}
        {body}
      </CallFrame>
      <ToastContainer />
    </>
  );
}
