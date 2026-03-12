import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Play, Square, Loader2, Users, Radio, Shuffle, Check, X, Pause, SkipForward, MessageSquare } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import { useState } from 'react';

interface Props { sessionId: string; }

export default function HostControls({ sessionId }: Props) {
  const { participants, phase, currentRound, totalRounds, transitionStatus, sessionStatus, matchPreview, setMatchPreview } = useSessionStore();
  const socket = getSocket();
  const [generating, setGenerating] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [showBroadcast, setShowBroadcast] = useState(false);

  const sessionStarted = sessionStatus !== 'scheduled' || transitionStatus === 'starting_session' || currentRound > 0;
  const isSessionEnding = transitionStatus === 'session_ending';
  const allRoundsDone = currentRound >= totalRounds && totalRounds > 0;
  const isInRound = phase === 'matched' || phase === 'rating';

  const startSession = () => socket?.emit('host:start_session', { sessionId });
  const endSession = () => socket?.emit('host:end_session', { sessionId });

  const generateMatches = () => {
    setGenerating(true);
    socket?.emit('host:generate_matches', { sessionId });
    const unsub = useSessionStore.subscribe((state) => {
      if (state.matchPreview) { setGenerating(false); unsub(); }
    });
    setTimeout(() => setGenerating(false), 10000);
  };

  const confirmRound = () => {
    socket?.emit('host:confirm_round', { sessionId });
    setMatchPreview(null);
  };

  const cancelPreview = () => setMatchPreview(null);

  const togglePause = () => {
    if (isPaused) {
      socket?.emit('host:resume_session', { sessionId });
    } else {
      socket?.emit('host:pause_session', { sessionId });
    }
    setIsPaused(!isPaused);
  };

  const sendBroadcast = () => {
    if (!broadcastMsg.trim()) return;
    socket?.emit('host:broadcast_message', { sessionId, message: broadcastMsg.trim() });
    setBroadcastMsg('');
    setShowBroadcast(false);
  };

  if (isSessionEnding) {
    return (
      <div className="border-t border-gray-200 bg-gray-50/60 backdrop-blur-sm p-4">
        <div className="max-w-4xl mx-auto flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-indigo-600 animate-spin" />
          <p className="text-sm text-gray-600 font-medium">Event ending — preparing your recap...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 bg-gray-50/60 backdrop-blur-sm">
      {/* Match preview panel */}
      {matchPreview && (
        <div className="border-b border-gray-200 bg-white px-4 py-3 max-h-60 overflow-y-auto">
          <div className="max-w-4xl mx-auto">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">
              Round {matchPreview.roundNumber} Preview — {matchPreview.matches.length} match{matchPreview.matches.length !== 1 ? 'es' : ''}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {matchPreview.matches.map((m, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-gray-50 rounded-lg px-3 py-1.5">
                  <span className="font-medium text-gray-700 truncate">{m.participantA.displayName}</span>
                  <span className="text-gray-400">×</span>
                  <span className="font-medium text-gray-700 truncate">{m.participantB.displayName}</span>
                </div>
              ))}
            </div>
            {matchPreview.byeParticipants.length > 0 && (
              <p className="text-xs text-amber-600 mt-2">
                Bye: {matchPreview.byeParticipants.map(p => p.displayName).join(', ')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Broadcast input */}
      {showBroadcast && (
        <div className="border-b border-gray-200 bg-white px-4 py-3">
          <div className="max-w-4xl mx-auto flex gap-2">
            <input
              type="text"
              value={broadcastMsg}
              onChange={e => setBroadcastMsg(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendBroadcast()}
              placeholder="Type a message to all participants..."
              className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              autoFocus
            />
            <Button size="sm" onClick={sendBroadcast} disabled={!broadcastMsg.trim()}>Send</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Control bar */}
      <div className="p-4">
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
                  {isPaused && ' — Paused'}
                </span>
              </div>
            )}
            {!isInRound && sessionStarted && !allRoundsDone && (
              <span className="text-xs text-gray-400">
                {currentRound > 0 ? `After Round ${currentRound}/${totalRounds}` : 'Lobby'}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {/* Start Event */}
            {!sessionStarted && (
              <Button size="sm" onClick={startSession}>
                <Play className="h-4 w-4 mr-1" /> Start Event
              </Button>
            )}

            {/* Two-step breakout: Match People → preview → Start Round */}
            {sessionStarted && phase === 'lobby' && !allRoundsDone && !matchPreview && (
              <Button size="sm" variant="secondary" onClick={generateMatches} disabled={generating}>
                {generating ? (
                  <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Matching...</>
                ) : (
                  <><Shuffle className="h-4 w-4 mr-1" /> Match People</>
                )}
              </Button>
            )}

            {/* After preview: Confirm or Cancel */}
            {matchPreview && (
              <>
                <Button size="sm" onClick={confirmRound}>
                  <Check className="h-4 w-4 mr-1" /> Start Round
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelPreview}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              </>
            )}

            {/* Pause/Resume during round */}
            {isInRound && phase === 'matched' && (
              <Button size="sm" variant="secondary" onClick={togglePause}>
                {isPaused ? <><Play className="h-4 w-4 mr-1" /> Resume</> : <><Pause className="h-4 w-4 mr-1" /> Pause</>}
              </Button>
            )}

            {/* Skip to next round (end current round early) */}
            {isInRound && phase === 'matched' && (
              <Button size="sm" variant="secondary" onClick={endSession} title="End round early">
                <SkipForward className="h-4 w-4 mr-1" /> End Round
              </Button>
            )}

            {/* Broadcast */}
            {sessionStarted && (
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(!showBroadcast)} title="Send message to all">
                <MessageSquare className="h-4 w-4" />
              </Button>
            )}

            <Button size="sm" variant="danger" onClick={endSession}>
              <Square className="h-4 w-4 mr-1" /> End
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
