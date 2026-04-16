import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { useSessionStore } from '@/stores/sessionStore';
import { useToastStore } from '@/stores/toastStore';
import { Star, CheckCircle, Loader2, Clock, Handshake } from 'lucide-react';
import api from '@/lib/api';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props { sessionId: string; }

type SubmissionState = null | { meetAgain: boolean };

function PartnerRatingForm({ partnerName, toUserId, matchId, onSubmitted, onSkip, partnerIndex, totalPartners }: {
  partnerName: string;
  toUserId: string;
  matchId: string;
  onSubmitted: (meetAgain: boolean) => void;
  onSkip: () => void;
  partnerIndex: number;
  totalPartners: number;
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

  return (
    <div className="max-w-md w-full text-center animate-fade-in-up bg-[#292a2d] rounded-2xl p-4 sm:p-8">
      {totalPartners > 1 && (
        <div className="flex items-center justify-center gap-1.5 mb-3">
          {Array.from({ length: totalPartners }).map((_, i) => (
            <div key={i} className={`h-1.5 rounded-full transition-all ${
              i === partnerIndex ? 'w-6 bg-white' : i < partnerIndex ? 'w-4 bg-emerald-500' : 'w-4 bg-white/20'
            }`} />
          ))}
        </div>
      )}
      <h2 className="text-xl font-bold text-white mb-2">Rate your conversation</h2>
      <p className="text-gray-400 mb-2">
        How was your chat with <span className="text-white font-medium">{partnerName}</span>?
      </p>
      <p className="text-xs text-gray-500 mb-5">Tap the stars to rate</p>

      <div className="flex justify-center gap-3 mb-6">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            onClick={() => setRating(n)}
            className="transition-transform hover:scale-110 active:scale-95"
          >
            <Star
              className={`h-12 w-12 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-gray-600 hover:text-gray-500'}`}
            />
          </button>
        ))}
      </div>

      <button
        onClick={() => setMeetAgain(!meetAgain)}
        className={`flex items-center justify-center gap-2.5 w-full py-3 rounded-xl border-2 transition-all mb-5 text-base font-medium ${
          meetAgain ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400' : 'border-white/10 text-gray-400 hover:border-white/20'
        }`}
      >
        <Handshake className={`h-5 w-5 ${meetAgain ? 'text-indigo-400' : ''}`} />
        {meetAgain ? 'Would meet again!' : 'Would you meet again?'}
      </button>

      <Button onClick={submit} isLoading={submitting} disabled={rating === 0 || submitting} className="w-full text-base py-3">
        Submit Rating
      </Button>

      <button onClick={onSkip} className="text-sm text-gray-500 hover:text-gray-300 mt-4 transition-colors">
        Skip
      </button>
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
    <div className="max-w-md w-full text-center animate-fade-in-up bg-[#292a2d] rounded-2xl p-4 sm:p-8 cursor-pointer" onClick={onContinue}>
      <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-emerald-500/20 text-emerald-400 mb-3">
        <CheckCircle className="h-7 w-7" />
      </div>
      <h2 className="text-lg font-bold text-white mb-1">Rating submitted!</h2>
      {meetAgain && (
        <div className="flex items-center justify-center gap-2 mt-2 px-4 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
          <Handshake className="h-4 w-4 text-indigo-400" />
          <p className="text-sm text-indigo-300">
            You want to meet again! We'll let you know if it's mutual.
          </p>
        </div>
      )}
      {isLastPartner && isLastRound && (
        <div className="flex items-center justify-center gap-2 mt-3 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Last round complete! Returning to main room...</span>
        </div>
      )}
    </div>
  );
}

export default function RatingPrompt(_props: Props) {
  const currentMatch = useSessionStore(s => s.currentMatch);
  const currentMatchId = useSessionStore(s => s.currentMatchId);
  const currentPartners = useSessionStore(s => s.currentPartners);
  const timerSeconds = useSessionStore(s => s.timerSeconds);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const { setPhase } = useSessionStore.getState();
  const { addToast } = useToastStore();
  const [currentPartnerIdx, setCurrentPartnerIdx] = useState(0);
  const [submissionState, setSubmissionState] = useState<SubmissionState>(null);
  const hasRedirected = useRef(false);

  const partners = currentPartners.length > 0
    ? currentPartners
    : currentMatch ? [currentMatch] : [];

  const noMatchData = !currentMatchId || partners.length === 0;
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
      setPhase('lobby');
    }
  }, [allDone, setPhase]);

  if (noMatchData) return null;
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
    setSubmissionState({ meetAgain });
  };

  const advance = () => setCurrentPartnerIdx(prev => prev + 1);

  return (
    <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
      {timerSeconds > 0 && (
        <div className="absolute top-4 right-4 flex items-center gap-1.5 text-sm text-gray-400 bg-[#292a2d]/80 backdrop-blur-sm rounded-full px-3 py-1">
          <Clock className="h-3.5 w-3.5" />
          <span>{timerSeconds}s</span>
        </div>
      )}
      <PartnerRatingForm
        key={partner.userId}
        partnerName={partner.displayName || 'your partner'}
        toUserId={partner.userId}
        matchId={currentMatchId}
        onSubmitted={handleSubmitted}
        onSkip={advance}
        partnerIndex={currentPartnerIdx}
        totalPartners={partners.length}
      />
    </div>
  );
}
