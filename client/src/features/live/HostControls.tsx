import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Play, Square, Zap, Loader2 } from 'lucide-react';
import { getSocket } from '@/lib/socket';

interface Props { sessionId: string; }

export default function HostControls({ sessionId }: Props) {
  const { participants, phase, currentRound, totalRounds, transitionStatus } = useSessionStore();
  const socket = getSocket();

  // Derive sessionStarted from store state instead of local useState
  const sessionStarted = currentRound > 0 || transitionStatus === 'starting_session' || transitionStatus === 'between_rounds' || transitionStatus === 'session_ending';
  const isSessionEnding = transitionStatus === 'session_ending';
  const allRoundsDone = currentRound >= totalRounds && totalRounds > 0;

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
        <p className="text-sm text-gray-500">{participants.length} in lobby</p>
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
