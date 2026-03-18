import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Play, Square, Loader2, Users, Radio, Shuffle, Check, X, Pause, SkipForward, MessageSquare, UserMinus, RefreshCw, UserPlus } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import { useState } from 'react';

interface Props { sessionId: string; }

export default function HostControls({ sessionId }: Props) {
  const { participants, phase, currentRound, totalRounds, transitionStatus, sessionStatus, matchPreview, setMatchPreview, roundDashboard } = useSessionStore();
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
      <div className="border-t border-white/10 bg-[#292a2d] p-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
            <p className="text-sm text-gray-300 font-medium">Event ending — preparing recap...</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(!showBroadcast)} title="Send announcement to all">
              <MessageSquare className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="danger" onClick={() => socket?.emit('host:end_session', { sessionId })}>
              <Square className="h-4 w-4 mr-1" /> Force End
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-white/10 bg-[#292a2d]">
      {/* Match preview panel with interactive controls */}
      {matchPreview && (
        <div className="border-b border-white/10 bg-[#1e1f22] px-4 py-3 max-h-72 overflow-y-auto">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-300">
                Round {matchPreview.roundNumber} Preview — {matchPreview.matches.length} match{matchPreview.matches.length !== 1 ? 'es' : ''}
              </h3>
              <div className="flex items-center gap-1.5">
                {swapMode && (
                  <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
                    Select second person to swap
                  </span>
                )}
                <button
                  onClick={regenerateMatches}
                  disabled={generating}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/10"
                  title="Re-run matching algorithm"
                >
                  {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Re-match
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {matchPreview.matches.map((m, i) => (
                <div key={i} className="flex items-center gap-1 text-xs bg-white/5 rounded-lg px-2 py-1.5">
                  <button
                    onClick={() => handleParticipantClick(m.participantA.userId)}
                    className={`font-medium truncate px-1.5 py-0.5 rounded transition-colors ${
                      swapMode === m.participantA.userId
                        ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
                        : 'text-gray-300 hover:bg-white/10 hover:text-white'
                    }`}
                    title="Click to swap this person"
                  >
                    {m.participantA.displayName}
                  </button>
                  <span className="text-gray-500 shrink-0">×</span>
                  <button
                    onClick={() => handleParticipantClick(m.participantB.userId)}
                    className={`font-medium truncate px-1.5 py-0.5 rounded transition-colors ${
                      swapMode === m.participantB.userId
                        ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
                        : 'text-gray-300 hover:bg-white/10 hover:text-white'
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
                            ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
                            : 'text-gray-300 hover:bg-white/10 hover:text-white'
                        }`}
                        title="Click to swap this person"
                      >
                        {m.participantC!.displayName}
                      </button>
                    </>
                  )}
                  {m.isTrio && (
                    <span className="text-[10px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                      Trio
                    </span>
                  )}
                  {m.metBefore && (
                    <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0" title={`Met ${m.timesMet} time${m.timesMet !== 1 ? 's' : ''} before`}>
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
              <p className="text-xs text-amber-400 mt-2">
                Bye: {matchPreview.byeParticipants.map(p => p.displayName).join(', ')}
              </p>
            )}
            <p className="text-[10px] text-gray-500 mt-1.5">
              Click names to swap between matches. Use <UserMinus className="h-2.5 w-2.5 inline" /> to exclude from round.
            </p>
          </div>
        </div>
      )}

      {/* Announcement input */}
      {showBroadcast && (
        <div className="border-b border-white/10 bg-amber-500/10 px-4 py-3">
          <p className="text-xs font-semibold text-amber-400 mb-2 max-w-4xl mx-auto">Announcement — visible as a banner to all participants</p>
          <div className="max-w-4xl mx-auto flex gap-2">
            <input
              type="text"
              value={broadcastMsg}
              onChange={e => setBroadcastMsg(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendBroadcast()}
              placeholder="Type an announcement..."
              style={{ color: '#000000' }}
              className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
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
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {Math.max(0, participants.length - 1)}</span>
              {roundDashboard && isInRound ? (() => {
                const inRooms = roundDashboard.rooms.reduce((n, r) => n + r.participants.length, 0);
                const byeCount = roundDashboard.byeParticipants.length;
                const disconnected = roundDashboard.rooms.reduce((n, r) => n + r.participants.filter(p => !p.isConnected).length, 0);
                const inLobby = Math.max(0, participants.length - 1 - inRooms - byeCount);
                return (
                  <>
                    <span className="text-gray-600">|</span>
                    <span className="text-green-400">{inRooms} in rooms</span>
                    {inLobby > 0 && <span className="text-blue-400">{inLobby} in lobby</span>}
                    {byeCount > 0 && <span className="text-amber-400">{byeCount} bye</span>}
                    {disconnected > 0 && <span className="text-red-400">{disconnected} disconnected</span>}
                  </>
                );
              })() : sessionStarted && (
                <>
                  <span className="text-gray-600">|</span>
                  <span className="text-blue-400">{Math.max(0, participants.length - 1)} in lobby</span>
                </>
              )}
            </div>
            {isInRound && (
              <div className="flex items-center gap-1.5">
                <Radio className="h-3.5 w-3.5 text-red-500 animate-pulse" />
                <span className="text-sm text-gray-300 font-medium">
                  Round {currentRound}/{totalRounds}
                  {phase === 'rating' && ' — Rating'}
                  {isPaused && ' — Paused'}
                </span>
              </div>
            )}
            {!isInRound && sessionStarted && !allRoundsDone && (
              <span className="text-xs text-gray-500">
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
                <span className="text-xs text-gray-500 px-2 py-1.5 border border-white/10 rounded-lg">
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

            {/* Announcement */}
            {sessionStarted && (
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(!showBroadcast)} title="Send announcement to all">
                <MessageSquare className="h-4 w-4" />
              </Button>
            )}

            {/* Invite people — opens session page in new tab */}
            {(sessionStatus === 'lobby_open' || sessionStatus === 'round_transition') && (
              <Button size="sm" variant="secondary" onClick={() => window.open(`/sessions/${sessionId}`, '_blank')}>
                <UserPlus className="h-4 w-4 mr-1" /> Invite
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
