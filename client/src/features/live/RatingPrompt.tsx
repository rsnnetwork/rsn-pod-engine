import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { useSessionStore } from '@/stores/sessionStore';
import { useToastStore } from '@/stores/toastStore';
import { Star, CheckCircle, Loader2, Handshake } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props { sessionId: string; }

type SubmissionState = null | { meetAgain: boolean };

// WS2 (27 May remaining work) — header + subline copy keyed by why the
// rating window opened. Default (null / 'round_end' / 'early_leave') keeps
// the existing copy; the two "your room ended early" reasons explain what
// happened so the form doesn't feel like a glitch.
function ratingCopy(reason: 'partner_no_return' | 'late_return' | 'round_end' | 'early_leave' | null): {
  heading: string;
  subline: string | null;
} {
  switch (reason) {
    case 'partner_no_return':
      return {
        heading: 'Your partner didn’t return',
        subline: 'Rate your conversation — returning you to the main room.',
      };
    case 'late_return':
      return { heading: 'Rate your last conversation', subline: null };
    default:
      return { heading: 'Rate your conversation', subline: null };
  }
}

function PartnerRatingForm({ partnerName, toUserId, matchId, onSubmitted, onSkip, partnerIndex, totalPartners, reason }: {
  partnerName: string;
  toUserId: string;
  matchId: string;
  onSubmitted: (meetAgain: boolean) => void;
  onSkip: () => void;
  partnerIndex: number;
  totalPartners: number;
  reason: 'partner_no_return' | 'late_return' | 'round_end' | 'early_leave' | null;
}) {
  const { addToast } = useToastStore();
  const [rating, setRating] = useState(0);
  const [meetAgain, setMeetAgain] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (rating === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api.post('/ratings', {
        matchId,
        qualityScore: rating,
        meetAgain,
        toUserId,
      });
      onSubmitted(meetAgain);
    } catch (err: any) {
      const errCode = err?.response?.data?.error?.code;
      if (errCode === 'MATCH_ALREADY_RATED') {
        // Already rated — treat as success, move to next partner
        onSubmitted(meetAgain);
      } else {
        const msg = err?.response?.data?.error?.message || 'Failed to submit rating';
        addToast(msg, 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // WS3/H5 — "this conversation didn't work" (partner never showed, tech
  // failure). Records a rating row so the one-per-match dedup and the
  // rejoin replay treat the match as handled, but flags it
  // excluded_from_quality_stats so it never drags down anyone's averages.
  const submitDidntWork = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.post('/ratings', {
        matchId,
        qualityScore: 1,
        meetAgain: false,
        toUserId,
        didntWork: true,
      });
      onSubmitted(false);
    } catch (err: any) {
      const errCode = err?.response?.data?.error?.code;
      if (errCode === 'MATCH_ALREADY_RATED') {
        onSubmitted(false);
      } else {
        const msg = err?.response?.data?.error?.message || 'Failed to submit';
        addToast(msg, 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // Phase 7 (1 May 2026 spec, item 8) — rating screen on white background.
    // Stefan: 'Rating screen wrong color (should be white)'. Pre-Phase-7 used
    // bg-[#292a2d] dark surface inconsistent with the rest of the app.
    <div className="max-w-md w-full text-center animate-fade-in-up bg-white border border-gray-200 rounded-2xl p-4 sm:p-8 shadow-lg">
      {totalPartners > 1 && (
        <div className="flex items-center justify-center gap-1.5 mb-3">
          {Array.from({ length: totalPartners }).map((_, i) => (
            <div key={i} className={`h-1.5 rounded-full transition-all ${
              i === partnerIndex ? 'w-6 bg-rsn-red' : i < partnerIndex ? 'w-4 bg-emerald-500' : 'w-4 bg-gray-200'
            }`} />
          ))}
        </div>
      )}
      <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">{ratingCopy(reason).heading}</h2>
      {ratingCopy(reason).subline && (
        <p className="text-sm text-gray-400 mb-2">{ratingCopy(reason).subline}</p>
      )}
      <p className="text-gray-500 mb-2">
        How was your chat with <span className="text-[#1a1a2e] font-medium">{partnerName}</span>?
      </p>
      <p className="text-xs text-gray-400 mb-5">Tap the stars to rate</p>

      <div className="flex justify-center gap-3 mb-6">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            onClick={() => setRating(n)}
            className="transition-transform hover:scale-110 active:scale-95"
          >
            <Star
              className={`h-12 w-12 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-gray-300 hover:text-gray-400'}`}
            />
          </button>
        ))}
      </div>

      <button
        onClick={() => setMeetAgain(!meetAgain)}
        className={`flex items-center justify-center gap-2.5 w-full py-3 rounded-xl border-2 transition-all mb-5 text-base font-medium ${
          meetAgain ? 'border-indigo-500 bg-indigo-50 text-indigo-600' : 'border-gray-200 text-gray-500 hover:border-gray-300'
        }`}
      >
        <Handshake className={`h-5 w-5 ${meetAgain ? 'text-indigo-500' : ''}`} />
        {meetAgain ? 'Would meet again!' : 'Would you meet again?'}
      </button>

      <Button onClick={submit} isLoading={submitting} disabled={rating === 0 || submitting} className="w-full text-base py-3">
        Submit Rating
      </Button>

      <div className="flex items-center justify-center gap-4 mt-4">
        <button onClick={onSkip} className="text-sm text-gray-400 hover:text-gray-600 transition-colors min-h-[44px]">
          Skip
        </button>
        <span className="text-gray-300">·</span>
        <button
          onClick={submitDidntWork}
          disabled={submitting}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors min-h-[44px]"
          title="Partner never showed or technical problems — won't affect quality stats"
        >
          This conversation didn&apos;t work
        </button>
      </div>
    </div>
  );
}

function RatingConfirmation({ meetAgain, isLastPartner, isLastRound, onContinue }: {
  meetAgain: boolean;
  isLastPartner: boolean;
  isLastRound: boolean;
  onContinue: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onContinue, 800);
    return () => clearTimeout(timer);
  }, [onContinue]);

  return (
    // Phase 7 (1 May spec) — confirmation card on white surface for visual
    // consistency with the rest of the app.
    <div className="max-w-md w-full text-center animate-fade-in-up bg-white border border-gray-200 rounded-2xl p-4 sm:p-8 cursor-pointer shadow-lg" onClick={onContinue}>
      <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-emerald-50 text-emerald-600 mb-3">
        <CheckCircle className="h-7 w-7" />
      </div>
      <h2 className="text-lg font-bold text-[#1a1a2e] mb-1">Rating submitted!</h2>
      {meetAgain && (
        <div className="flex items-center justify-center gap-2 mt-2 px-4 py-2 rounded-lg bg-indigo-50 border border-indigo-200">
          <Handshake className="h-4 w-4 text-indigo-500" />
          <p className="text-sm text-indigo-700">
            You want to meet again! We'll let you know if it's mutual.
          </p>
        </div>
      )}
      {isLastPartner && isLastRound && (
        <div className="flex items-center justify-center gap-2 mt-3 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Last round complete! Returning to main room...</span>
        </div>
      )}
    </div>
  );
}

export default function RatingPrompt(props: Props) {
  const currentMatch = useSessionStore(s => s.currentMatch);
  const currentMatchId = useSessionStore(s => s.currentMatchId);
  const currentPartners = useSessionStore(s => s.currentPartners);
  const ratingReason = useSessionStore(s => s.ratingReason);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const ratedMatchIds = useSessionStore(s => s.ratedMatchIds);
  const { setPhase } = useSessionStore.getState();
  const { addToast } = useToastStore();
  const [currentPartnerIdx, setCurrentPartnerIdx] = useState(0);
  const [submissionState, setSubmissionState] = useState<SubmissionState>(null);
  const hasRedirected = useRef(false);

  const partners = currentPartners.length > 0
    ? currentPartners
    : currentMatch ? [currentMatch] : [];

  const noMatchData = !currentMatchId || partners.length === 0;
  // #C (26 May, live-test-3) — this match was already fully rated/skipped (it's
  // in ratedMatchIds). The #2 guard covered the rating:window_open path, but
  // session:round_ended sets phase='rating' DIRECTLY for everyone, re-showing
  // the form for a pulled-out pair who already rated (Ali: "I press End Round
  // and they have to rate again"). Match-keyed, so a GENUINE re-match (new
  // matchId, not in the set) still prompts normally.
  const alreadySettledMatch = !!currentMatchId && ratedMatchIds.has(currentMatchId);
  const isLastRound = currentRound >= totalRounds && totalRounds > 0;
  const isLastPartner = currentPartnerIdx >= partners.length - 1;
  const allDone = currentPartnerIdx >= partners.length && submissionState === null;

  // ALL hooks MUST be above any conditional returns (React Rules of Hooks)
  useEffect(() => {
    if (noMatchData && !hasRedirected.current) {
      hasRedirected.current = true;
      addToast('No match data available to rate', 'error');
      setPhase('lobby');
    }
  }, [noMatchData, addToast, setPhase]);

  useEffect(() => {
    if (allDone && !hasRedirected.current) {
      hasRedirected.current = true;
      // #6 (24 May, Ali) — mark this round's rating as done so a later
      // round_rating phase transition does NOT re-open the form. An early-leaver
      // who already rated (their form returns them to lobby, then the round
      // ends) was re-prompted because lastRatedRound was only set on
      // rating:window_closed. allDone fires after the LAST partner, so a trio
      // still gets both forms first and a pair gets exactly one. Server-driven
      // rating:window_open (genuine reassignment to a new partner) bypasses the
      // round_rating guard, so legitimate re-prompts still work.
      if (currentRound > 0) useSessionStore.getState().setLastRatedRound(currentRound);
      // #2 (26 May, live-test-2) — this match is now FULLY handled (every
      // partner rated or skipped). Record its matchId so a re-emitted
      // rating:window_open for the SAME match during re-match churn is
      // suppressed instead of re-showing the form (which the user then
      // re-rated → server 409 → "rate again"). A genuine re-match has a new
      // matchId and is not in this set, so it still prompts normally.
      if (currentMatchId) useSessionStore.getState().addRatedMatchId(currentMatchId);
      setPhase('lobby');
    }
  }, [allDone, setPhase, currentRound, currentMatchId]);

  // #C (26 May) — if we were dropped into the rating phase for a match we've
  // already settled (e.g. End Round broadcasting session:round_ended after a
  // pulled-out pair already rated), leave straight back to the lobby instead of
  // re-showing the form.
  useEffect(() => {
    if (alreadySettledMatch && !hasRedirected.current) {
      hasRedirected.current = true;
      setPhase('lobby');
    }
  }, [alreadySettledMatch, setPhase]);

  if (noMatchData) return null;
  if (alreadySettledMatch) return null;
  if (allDone) return null;

  // Show the brief confirmation after submitting a rating
  if (submissionState !== null) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <RatingConfirmation
          meetAgain={submissionState.meetAgain}
          isLastPartner={isLastPartner || currentPartnerIdx >= partners.length}
          isLastRound={isLastRound}
          onContinue={() => {
            setSubmissionState(null);
            setCurrentPartnerIdx(prev => prev + 1);
          }}
        />
      </div>
    );
  }

  const partner = partners[currentPartnerIdx];

  const handleSubmitted = (meetAgain: boolean) => {
    // #2 (25 May, Ali) — record the round as rated the MOMENT the last partner is
    // submitted, not after the user clicks through the confirmation screen.
    // Otherwise a round ending while the confirmation is up re-opens the form via
    // the round_rating phase transition (the "already rated, prompted again" bug).
    if (isLastPartner && currentRound > 0) useSessionStore.getState().setLastRatedRound(currentRound);
    setSubmissionState({ meetAgain });
  };

  const advance = () => setCurrentPartnerIdx(prev => prev + 1);
  // #6 (25 May, Ali) — Skip = "saw it, don't want to rate". Tell the server so
  // the round-end emit + reconnect rating-replay never re-prompt this match.
  const skip = () => {
    if (currentMatchId) {
      try { getSocket().emit('rating:skip', { sessionId: props.sessionId, matchId: currentMatchId }); } catch { /* non-fatal */ }
    }
    advance();
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
      <PartnerRatingForm
        key={partner.userId}
        partnerName={partner.displayName || 'your partner'}
        toUserId={partner.userId}
        matchId={currentMatchId}
        onSubmitted={handleSubmitted}
        onSkip={skip}
        partnerIndex={currentPartnerIdx}
        totalPartners={partners.length}
        reason={ratingReason}
      />
    </div>
  );
}
