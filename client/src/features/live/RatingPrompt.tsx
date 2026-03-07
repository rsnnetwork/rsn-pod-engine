import { useState } from 'react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useSessionStore } from '@/stores/sessionStore';
import { useToastStore } from '@/stores/toastStore';
import { Star, UserCheck } from 'lucide-react';
import api from '@/lib/api';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props { sessionId: string; }

export default function RatingPrompt(_props: Props) {
  const { currentMatch, currentMatchId, setPhase } = useSessionStore();
  const { addToast } = useToastStore();
  const [rating, setRating] = useState(0);
  const [meetAgain, setMeetAgain] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!currentMatchId || !currentMatch) {
      addToast('No match data available to rate', 'error');
      setPhase('lobby');
      return;
    }
    if (rating === 0) return;
    setSubmitting(true);
    try {
      await api.post('/ratings', {
        matchId: currentMatchId,
        qualityScore: rating,
        meetAgain,
      });
      addToast('Rating submitted!', 'success');
      setPhase('lobby');
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || 'Failed to submit rating';
      addToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <Card className="max-w-md w-full text-center">
        <h2 className="text-xl font-bold text-surface-100 mb-2">Rate your conversation</h2>
        <p className="text-surface-400 mb-6">
          How was your chat with {currentMatch?.displayName || 'your partner'}?
        </p>

        <div className="flex justify-center gap-2 mb-6">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onClick={() => setRating(n)}
              className="transition-transform hover:scale-110"
            >
              <Star
                className={`h-10 w-10 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-surface-600'}`}
              />
            </button>
          ))}
        </div>

        <button
          onClick={() => setMeetAgain(!meetAgain)}
          className={`flex items-center justify-center gap-2 w-full py-2 rounded-lg border transition-colors mb-4 ${
            meetAgain ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400' : 'border-surface-700 text-surface-400 hover:border-surface-600'
          }`}
        >
          <UserCheck className="h-4 w-4" />
          {meetAgain ? 'Would meet again!' : 'Would you meet again?'}
        </button>

        <Button onClick={submit} isLoading={submitting} disabled={rating === 0} className="w-full">
          Submit Rating
        </Button>

        <button onClick={() => setPhase('lobby')} className="text-sm text-surface-500 hover:text-surface-300 mt-4 transition-colors">
          Skip
        </button>
      </Card>
    </div>
  );
}
