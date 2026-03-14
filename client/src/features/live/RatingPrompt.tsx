import { useState, useEffect, useRef } from 'react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useSessionStore } from '@/stores/sessionStore';
import { useToastStore } from '@/stores/toastStore';
import { Star, UserCheck, CheckCircle, Loader2, Clock } from 'lucide-react';
import api from '@/lib/api';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props { sessionId: string; }

function PartnerRatingForm({ partnerName, toUserId, matchId, onSubmitted, onSkip, partnerIndex, totalPartners }: {
  partnerName: string;
  toUserId: string;
  matchId: string;
  onSubmitted: () => void;
  onSkip: () => void;
  partnerIndex: number;
  totalPartners: number;
}) {
  const { addToast } = useToastStore();
  const [rating, setRating] = useState(0);
  const [meetAgain, setMeetAgain] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (rating === 0) return;
    setSubmitting(true);
    try {
      await api.post('/ratings', {
        matchId,
        qualityScore: rating,
        meetAgain,
        toUserId,
      });
      addToast(`Rating for ${partnerName} submitted!`, 'success');
      onSubmitted();
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || 'Failed to submit rating';
      addToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="max-w-md w-full text-center">
      {totalPartners > 1 && (
        <p className="text-xs text-gray-400 mb-2">Partner {partnerIndex + 1} of {totalPartners}</p>
      )}
      <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Rate your conversation</h2>
      <p className="text-gray-500 mb-6">
        How was your chat with {partnerName}?
      </p>

      <div className="flex justify-center gap-2 mb-6">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            onClick={() => setRating(n)}
            className="transition-transform hover:scale-110"
          >
            <Star
              className={`h-10 w-10 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-gray-300'}`}
            />
          </button>
        ))}
      </div>

      <button
        onClick={() => setMeetAgain(!meetAgain)}
        className={`flex items-center justify-center gap-2 w-full py-2 rounded-lg border transition-colors mb-4 ${
          meetAgain ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400' : 'border-gray-200 text-gray-500 hover:border-gray-300'
        }`}
      >
        <UserCheck className="h-4 w-4" />
        {meetAgain ? 'Would meet again!' : 'Would you meet again?'}
      </button>

      <Button onClick={submit} isLoading={submitting} disabled={rating === 0} className="w-full">
        Submit Rating
      </Button>

      <button onClick={onSkip} className="text-sm text-gray-400 hover:text-gray-600 mt-4 transition-colors">
        Skip
      </button>
    </Card>
  );
}

export default function RatingPrompt(_props: Props) {
  const { currentMatch, currentMatchId, currentPartners, timerSeconds, setPhase, currentRound, totalRounds } = useSessionStore();
  const { addToast } = useToastStore();
  const [currentPartnerIdx, setCurrentPartnerIdx] = useState(0);
  const hasRedirected = useRef(false);

  const partners = currentPartners.length > 0
    ? currentPartners
    : currentMatch ? [currentMatch] : [];

  const noMatchData = !currentMatchId || partners.length === 0;

  // Handle missing match data safely via useEffect (not during render)
  useEffect(() => {
    if (noMatchData && !hasRedirected.current) {
      hasRedirected.current = true;
      addToast('No match data available to rate', 'error');
      setPhase('lobby');
    }
  }, [noMatchData, addToast, setPhase]);

  if (noMatchData) return null;

  const allDone = currentPartnerIdx >= partners.length;

  if (allDone) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-emerald-500/20 text-emerald-400 mb-4">
            <CheckCircle className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">
            {partners.length > 1 ? 'All Ratings Submitted!' : 'Rating Submitted!'}
          </h2>
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 text-gray-500 animate-spin" />
            <p className="text-gray-500">
              {currentRound >= totalRounds && totalRounds > 0
                ? 'Event wrapping up — preparing your recap...'
                : 'Waiting for the next round to begin...'}
            </p>
          </div>
          {timerSeconds > 0 && (
            <div className="flex items-center justify-center gap-1.5 mt-3 text-sm text-gray-400">
              <Clock className="h-3.5 w-3.5" />
              <span>{timerSeconds}s remaining</span>
            </div>
          )}
        </Card>
      </div>
    );
  }

  const partner = partners[currentPartnerIdx];
  const advance = () => setCurrentPartnerIdx(prev => prev + 1);

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      {timerSeconds > 0 && (
        <div className="absolute top-4 right-4 flex items-center gap-1.5 text-sm text-gray-400 bg-white/80 backdrop-blur-sm rounded-full px-3 py-1">
          <Clock className="h-3.5 w-3.5" />
          <span>{timerSeconds}s</span>
        </div>
      )}
      <PartnerRatingForm
        key={partner.userId}
        partnerName={partner.displayName || 'your partner'}
        toUserId={partner.userId}
        matchId={currentMatchId}
        onSubmitted={advance}
        onSkip={advance}
        partnerIndex={currentPartnerIdx}
        totalPartners={partners.length}
      />
    </div>
  );
}
