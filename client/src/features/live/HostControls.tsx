import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Play, Square, Zap, Loader2, Users, Radio } from 'lucide-react';
import { getSocket } from '@/lib/socket';

interface Props { sessionId: string; }

export default function HostControls({ sessionId }: Props) {
  const { participants, phase, currentRound, totalRounds, transitionStatus, sessionStatus, timerSeconds } = useSessionStore();
  const socket = getSocket();

  // Session has been started if status is lobby_open or later, OR if we're in a transition state
  const sessionStarted = sessionStatus !== 'scheduled' || transitionStatus === 'starting_session' || currentRound > 0;
  const isSessionEnding = transitionStatus === 'session_ending';
  const allRoundsDone = currentRound >= totalRounds && totalRounds > 0;
  const isInRound = phase === 'matched' || phase === 'rating';

  const startSession = () => socket?.emit('host:start_session', { sessionId });
  const startRound = () => socket?.emit('host:start_round', { sessionId });
  const endSession = () => socket?.emit('host:end_session', { sessionId });

  // During session ending, show a simple status bar
  if (isSessionEnding) {
    return (
      <div className="border-t border-gray-200 bg-gray-50/60 backdrop-blur-sm p-4">
        <div className="max-w-4xl mx-auto flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-indigo-600 animate-spin" />
          <p className="text-sm text-gray-600 font-medium">Session ending — preparing your recap...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 bg-gray-50/60 backdrop-blur-sm p-4">
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-sm text-gray-500">
            <Users className="h-3.5 w-3.5" />
            <span>{participants.length}</span>
          </div>
          {isInRound && (
            <div className="flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 text-red-500 animate-pulse" />
              <span className="text-sm text-gray-600 font-medium">
                Round {currentRound}/{totalRounds}
                {phase === 'rating' && ' — Rating'}
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {/* Start Session — only shown before session has started */}
          {!sessionStarted && (
            <Button size="sm" onClick={startSession}>
              <Play className="h-4 w-4 mr-1" /> Start Session
            </Button>
          )}

          {/* Start Round — only when in lobby AND more rounds remain */}
          {sessionStarted && phase === 'lobby' && !allRoundsDone && (
            <Button size="sm" variant="secondary" onClick={startRound}>
              <Zap className="h-4 w-4 mr-1" /> Start Round
            </Button>
          )}

          <Button size="sm" variant="danger" onClick={endSession}>
            <Square className="h-4 w-4 mr-1" /> End
          </Button>
        </div>
      </div>
    </div>
  );
}
