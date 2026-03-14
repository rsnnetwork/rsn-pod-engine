import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Play, Square, Loader2, Users, Radio, Shuffle, Check, X, Pause, SkipForward, MessageSquare, UserMinus, RefreshCw } from 'lucide-react';
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
  const [swapMode, setSwapMode] = useState<string | null>(null); // userId of first selected participant for swap

  const sessionStarted = sessionStatus !== 'scheduled' || transitionStatus === 'starting_session' || currentRound > 0;
  const isSessionEnding = transitionStatus === 'session_ending';
  const allRoundsDone = currentRound >= totalRounds && totalRounds > 0;
  const isInRound = phase === 'matched' || phase === 'rating';

  const startSession = () => socket?.emit('host:start_session', { sessionId });
  const endSession = () => {
    const msg = isInRound
      ? 'A round is currently active. Ending the event will cut all conversations short. Are you sure?'
      : 'Are you sure you want to end this event? All participants will be disconnected.';
    if (!confirm(msg)) return;
    socket?.emit('host:end_session', { sessionId });
  };

  // Count non-host participants for matching eligibility
  const eligibleCount = Math.max(0, participants.length - 1); // exclude host

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
    setSwapMode(null);
  };

  const cancelPreview = () => {
    setMatchPreview(null);
    setSwapMode(null);
  };

  const regenerateMatches = () => {
    setGenerating(true);
    socket?.emit('host:regenerate_matches' as any, { sessionId });
    const unsub = useSessionStore.subscribe((state) => {
      if (state.matchPreview) { setGenerating(false); unsub(); }
    });
    setTimeout(() => setGenerating(false), 10000);
  };

  const handleParticipantClick = (userId: string) => {
    if (!swapMode) {
      setSwapMode(userId);
    } else if (swapMode === userId) {
      setSwapMode(null); // deselect
    } else {
      // Swap the two participants
      socket?.emit('host:swap_match' as any, { sessionId, userA: swapMode, userB: userId });
      setSwapMode(null);
    }
  };

  const excludeParticipant = (userId: string) => {
    socket?.emit('host:exclude_participant' as any, { sessionId, userId });
    setSwapMode(null);
  };

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
      {/* Match preview panel with interactive controls */}
      {matchPreview && (
        <div className="border-b border-gray-200 bg-white px-4 py-3 max-h-72 overflow-y-auto">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">
                Round {matchPreview.roundNumber} Preview — {matchPreview.matches.length} match{matchPreview.matches.length !== 1 ? 'es' : ''}
              </h3>
              <div className="flex items-center gap-1.5">
                {swapMode && (
                  <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                    Select second person to swap
                  </span>
                )}
                <button
                  onClick={regenerateMatches}
                  disabled={generating}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 transition-colors px-2 py-1 rounded hover:bg-gray-100"
                  title="Re-run matching algorithm"
                >
                  {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Re-match
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {matchPreview.matches.map((m, i) => (
                <div key={i} className="flex items-center gap-1 text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                  <button
                    onClick={() => handleParticipantClick(m.participantA.userId)}
                    className={`font-medium truncate px-1.5 py-0.5 rounded transition-colors ${
                      swapMode === m.participantA.userId
                        ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                        : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                    }`}
                    title="Click to swap this person"
                  >
                    {m.participantA.displayName}
                  </button>
                  <span className="text-gray-400 shrink-0">×</span>
                  <button
                    onClick={() => handleParticipantClick(m.participantB.userId)}
                    className={`font-medium truncate px-1.5 py-0.5 rounded transition-colors ${
                      swapMode === m.participantB.userId
                        ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                        : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                    }`}
                    title="Click to swap this person"
                  >
                    {m.participantB.displayName}
                  </button>
                  {m.participantC && (
                    <>
                      <span className="text-gray-400 shrink-0">×</span>
                      <button
                        onClick={() => handleParticipantClick(m.participantC!.userId)}
                        className={`font-medium truncate px-1.5 py-0.5 rounded transition-colors ${
                          swapMode === m.participantC!.userId
                            ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                            : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                        }`}
                        title="Click to swap this person"
                      >
                        {m.participantC!.displayName}
                      </button>
                    </>
                  )}
                  {m.isTrio && (
                    <span className="text-[10px] text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded-full shrink-0">
                      Trio
                    </span>
                  )}
                  {m.metBefore && (
                    <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full shrink-0" title={`Met ${m.timesMet} time${m.timesMet !== 1 ? 's' : ''} before`}>
                      Met {m.timesMet}x
                    </span>
                  )}
                  <div className="flex gap-0.5 ml-auto shrink-0">
                    <button
                      onClick={() => excludeParticipant(m.participantA.userId)}
                      className="p-0.5 text-gray-300 hover:text-red-400 transition-colors"
                      title={`Exclude ${m.participantA.displayName}`}
                    >
                      <UserMinus className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => excludeParticipant(m.participantB.userId)}
                      className="p-0.5 text-gray-300 hover:text-red-400 transition-colors"
                      title={`Exclude ${m.participantB.displayName}`}
                    >
                      <UserMinus className="h-3 w-3" />
                    </button>
                    {m.participantC && (
                      <button
                        onClick={() => excludeParticipant(m.participantC!.userId)}
                        className="p-0.5 text-gray-300 hover:text-red-400 transition-colors"
                        title={`Exclude ${m.participantC!.displayName}`}
                      >
                        <UserMinus className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {matchPreview.byeParticipants.length > 0 && (
              <p className="text-xs text-amber-600 mt-2">
                Bye: {matchPreview.byeParticipants.map(p => p.displayName).join(', ')}
              </p>
            )}
            <p className="text-[10px] text-gray-400 mt-1.5">
              Click names to swap between matches. Use <UserMinus className="h-2.5 w-2.5 inline" /> to exclude from round.
            </p>
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
              <span>{Math.max(0, participants.length - 1)}</span>
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
              eligibleCount >= 2 ? (
                <Button size="sm" variant="secondary" onClick={generateMatches} disabled={generating}>
                  {generating ? (
                    <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Matching...</>
                  ) : (
                    <><Shuffle className="h-4 w-4 mr-1" /> Match People</>
                  )}
                </Button>
              ) : (
                <span className="text-xs text-gray-400 px-2 py-1.5 border border-gray-200 rounded-lg">
                  Need {2 - eligibleCount} more participant{eligibleCount === 1 ? '' : 's'} to match
                </span>
              )
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
