import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Play, Square, Loader2, Users, Radio, Shuffle, Check, X, Pause, SkipForward, MessageSquare, UserMinus, RefreshCw, UserPlus, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import { useState } from 'react';

interface Props { sessionId: string; }

export default function HostControls({ sessionId }: Props) {
  const participants = useSessionStore(s => s.participants);
  const phase = useSessionStore(s => s.phase);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const transitionStatus = useSessionStore(s => s.transitionStatus);
  const sessionStatus = useSessionStore(s => s.sessionStatus);
  const matchPreview = useSessionStore(s => s.matchPreview);
  const roundDashboard = useSessionStore(s => s.roundDashboard);
  const { setMatchPreview } = useSessionStore.getState();
  const socket = getSocket();
  const [generating, setGenerating] = useState(false);
  const [matchesConfirmed, setMatchesConfirmed] = useState(false);
  const isPaused = useSessionStore(s => s.isPaused);
  const { setIsPaused } = useSessionStore.getState();
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [swapMode, setSwapMode] = useState<string | null>(null); // userId of first selected participant for swap
  const [manualMatchMode, setManualMatchMode] = useState(false);
  const [manualA, setManualA] = useState<string | null>(null);
  const [manualB, setManualB] = useState<string | null>(null);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [createRoomDuration, setCreateRoomDuration] = useState(300); // 5 min default
  const [createRoomSelected, setCreateRoomSelected] = useState<Set<string>>(new Set());

  const sessionStarted = sessionStatus !== 'scheduled' || transitionStatus === 'starting_session' || currentRound > 0;
  const isSessionEnding = transitionStatus === 'session_ending';
  const allRoundsDone = currentRound >= totalRounds && totalRounds > 0;
  const isInRound = sessionStatus === 'round_active' || sessionStatus === 'round_rating' || phase === 'matched' || phase === 'rating';

  const startSession = () => socket?.emit('host:start_session', { sessionId });
  const endCurrentRound = () => {
    if (!confirm('End this round early? Participants will move to the rating screen.')) return;
    socket?.emit('host:end_session', { sessionId });
  };
  const endEvent = () => {
    const msg = isInRound
      ? 'A round is currently active. Ending the event will cut all conversations short. Are you sure?'
      : 'Are you sure you want to end this event? All participants will be disconnected.';
    if (!confirm(msg)) return;
    socket?.emit('host:end_session', { sessionId });
  };

  // Count non-host/co-host participants for matching eligibility
  const cohosts = useSessionStore(s => s.cohosts);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const eligibleCount = participants.filter(p => p.userId !== hostUserId && !cohosts.has(p.userId)).length;

  const generateMatches = () => {
    setGenerating(true);
    socket?.emit('host:generate_matches', { sessionId });
    const unsub = useSessionStore.subscribe((state) => {
      if (state.matchPreview) { setGenerating(false); unsub(); }
    });
    // Listen for error to stop spinner and show feedback
    const onError = (err: any) => {
      if (err?.code === 'GENERATE_FAILED' || err?.code === 'NOT_ENOUGH_PARTICIPANTS') {
        setGenerating(false);
        useSessionStore.getState().setError(err.message || 'Failed to generate matches');
        socket?.off('error', onError);
      }
    };
    socket?.on('error', onError);
    setTimeout(() => { setGenerating(false); socket?.off('error', onError); }, 10000);
  };

  const confirmMatches = () => {
    socket?.emit('host:confirm_matches' as any, { sessionId });
    setMatchesConfirmed(true);
  };

  const confirmRound = () => {
    socket?.emit('host:confirm_round', { sessionId });
    setMatchPreview(null);
    setMatchesConfirmed(false);
    setSwapMode(null);
  };

  const cancelPreview = () => {
    socket?.emit('host:cancel_preview', { sessionId });
    setMatchPreview(null);
    setMatchesConfirmed(false);
    setSwapMode(null);
  };

  const regenerateMatches = () => {
    setGenerating(true);
    socket?.emit('host:regenerate_matches' as any, { sessionId });
    const unsub = useSessionStore.subscribe((state) => {
      if (state.matchPreview) { setGenerating(false); unsub(); }
    });
    const onError = (err: any) => {
      if (err?.code === 'REGENERATE_FAILED') {
        setGenerating(false);
        useSessionStore.getState().setError(err.message || 'Failed to re-match');
        socket?.off('error', onError);
      }
    };
    socket?.on('error', onError);
    setTimeout(() => { setGenerating(false); socket?.off('error', onError); }, 10000);
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
    // Optimistic update — server will confirm via session:status_changed
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
      <div className="border-t border-gray-200 bg-white">
        {/* Announcement input — available in wrapping-up state */}
        {showBroadcast && (
          <div className="border-b border-gray-200 bg-amber-500/10 px-4 py-3">
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
        <div className="p-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <p className="text-sm text-gray-700 font-medium">All rounds complete</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(!showBroadcast)} title="Send announcement to all">
                <MessageSquare className="h-4 w-4" />
              </Button>
              <Button size="sm" onClick={() => {
                if (eligibleCount < 2) {
                  alert(`Need at least 2 participants to start a round (currently ${eligibleCount})`);
                  return;
                }
                socket?.emit('host:start_round', { sessionId });
              }}>
                <Play className="h-4 w-4 mr-1" /> Another Round
              </Button>
              <Button size="sm" variant="danger" onClick={() => socket?.emit('host:end_session', { sessionId })}>
                <Square className="h-4 w-4 mr-1" /> End Event
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 bg-white">
      {/* Match preview panel with interactive controls */}
      {matchPreview && (
        <div className="border-b border-gray-200 bg-emerald-50 px-4 py-3 max-h-72 overflow-y-auto animate-fade-in">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-emerald-700 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                {matchPreview.matches.length} match{matchPreview.matches.length !== 1 ? 'es' : ''} ready — Round {matchPreview.roundNumber}
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
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 transition-colors px-2 py-1 rounded hover:bg-blue-50"
                  title="Re-run matching algorithm"
                >
                  {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Re-match
                </button>
                <button
                  onClick={() => { setManualMatchMode(!manualMatchMode); setManualA(null); setManualB(null); }}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-emerald-600 transition-colors px-2 py-1 rounded hover:bg-emerald-50"
                  title="Manually pair two participants"
                >
                  <UserPlus className="h-3 w-3" />
                  Manual Match
                </button>
              </div>
            </div>
            {manualMatchMode && (
              <div className="flex items-center gap-2 mb-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <select
                  value={manualA || ''}
                  onChange={e => setManualA(e.target.value || null)}
                  className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-900 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <option value="">Select person 1</option>
                  {participants.filter(p => p.userId !== hostUserId && !cohosts.has(p.userId)).map(p => (
                    <option key={p.userId} value={p.userId}>{p.displayName}</option>
                  ))}
                </select>
                <span className="text-gray-400 text-xs">+</span>
                <select
                  value={manualB || ''}
                  onChange={e => setManualB(e.target.value || null)}
                  className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-900 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <option value="">Select person 2</option>
                  {participants.filter(p => p.userId !== hostUserId && !cohosts.has(p.userId) && p.userId !== manualA).map(p => (
                    <option key={p.userId} value={p.userId}>{p.displayName}</option>
                  ))}
                </select>
                <Button size="sm" disabled={!manualA || !manualB} onClick={() => {
                  socket?.emit('host:force_match' as any, { sessionId, userIdA: manualA, userIdB: manualB });
                  setManualMatchMode(false);
                  setManualA(null);
                  setManualB(null);
                }}>
                  Pair
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setManualMatchMode(false); setManualA(null); setManualB(null); }}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
            {matchPreview.warnings && matchPreview.warnings.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
                <div className="text-xs text-amber-300">
                  {matchPreview.warnings.map((w, i) => <p key={i}>{w}</p>)}
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {matchPreview.matches.map((m, i) => (
                <div key={i} className="flex items-center gap-1 text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                  <button
                    onClick={() => handleParticipantClick(m.participantA.userId)}
                    className={`font-medium truncate px-1.5 py-0.5 rounded transition-colors ${
                      swapMode === m.participantA.userId
                        ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
                        : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
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
                        : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
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
                            : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
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
                      className="p-0.5 text-gray-700 hover:text-red-400 transition-colors"
                      title={`Exclude ${m.participantA.displayName}`}
                    >
                      <UserMinus className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => excludeParticipant(m.participantB.userId)}
                      className="p-0.5 text-gray-700 hover:text-red-400 transition-colors"
                      title={`Exclude ${m.participantB.displayName}`}
                    >
                      <UserMinus className="h-3 w-3" />
                    </button>
                    {m.participantC && (
                      <button
                        onClick={() => excludeParticipant(m.participantC!.userId)}
                        className="p-0.5 text-gray-700 hover:text-red-400 transition-colors"
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
                Not matched: {matchPreview.byeParticipants.map(p => p.displayName).join(', ')}
              </p>
            )}
            <p className="text-[10px] text-gray-500 mt-1.5">
              Click names to swap between matches. Use <UserMinus className="h-2.5 w-2.5 inline" /> to exclude from round.
            </p>
          </div>
        </div>
      )}

      {/* Create Room panel */}
      {showCreateRoom && (
        <div className="border-b border-gray-200 bg-emerald-50 px-4 py-3">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-emerald-700 flex items-center gap-2">
                <UserPlus className="h-4 w-4" /> Create Breakout Room
              </h3>
              <button onClick={() => { setShowCreateRoom(false); setCreateRoomSelected(new Set()); }} className="text-xs text-gray-500 hover:text-gray-700">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-3 mb-2">
              <label className="text-xs text-gray-600 font-medium">Duration:</label>
              <select
                value={createRoomDuration}
                onChange={e => setCreateRoomDuration(Number(e.target.value))}
                className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-900 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              >
                <option value={180}>3 min</option>
                <option value={300}>5 min</option>
                <option value={600}>10 min</option>
                <option value={900}>15 min</option>
                <option value={1200}>20 min</option>
                <option value={1800}>30 min</option>
                <option value={0}>No limit</option>
              </select>
              <span className="text-xs text-gray-500">
                {createRoomSelected.size} participant{createRoomSelected.size !== 1 ? 's' : ''} selected
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto mb-2">
              {participants
                .filter(p => p.userId !== hostUserId && !cohosts.has(p.userId))
                .map(p => {
                  const inRoom = roundDashboard?.rooms.some(r =>
                    r.status === 'active' && r.participants.some(rp => rp.userId === p.userId)
                  );
                  return (
                    <label
                      key={p.userId}
                      className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                        createRoomSelected.has(p.userId) ? 'bg-emerald-100 border border-emerald-300' :
                        inRoom ? 'bg-blue-50 border border-blue-200' : 'bg-white border border-gray-200'
                      } ${createRoomSelected.size >= 3 && !createRoomSelected.has(p.userId) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-50'}`}
                    >
                      <input
                        type="checkbox"
                        checked={createRoomSelected.has(p.userId)}
                        disabled={createRoomSelected.size >= 3 && !createRoomSelected.has(p.userId)}
                        onChange={() => {
                          setCreateRoomSelected(prev => {
                            const next = new Set(prev);
                            if (next.has(p.userId)) next.delete(p.userId);
                            else if (next.size < 3) next.add(p.userId);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-500 focus:ring-emerald-400"
                      />
                      <span className="truncate text-gray-700">{p.displayName}</span>
                      {inRoom && <span className="text-[10px] text-blue-500 shrink-0">(in room)</span>}
                    </label>
                  );
                })}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={createRoomSelected.size === 0} onClick={() => {
                socket?.emit('host:create_breakout' as any, {
                  sessionId,
                  participantIds: Array.from(createRoomSelected),
                  durationSeconds: createRoomDuration || undefined,
                });
                setShowCreateRoom(false);
                setCreateRoomSelected(new Set());
              }}>
                Create Room ({createRoomSelected.size})
              </Button>
              <span className="text-[10px] text-gray-500">Select 1-3 participants to create a room.</span>
            </div>
          </div>
        </div>
      )}

      {/* Announcement input */}
      {showBroadcast && (
        <div className="border-b border-gray-200 bg-amber-500/10 px-4 py-3">
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
              <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {eligibleCount}</span>
              {roundDashboard && isInRound ? (() => {
                const inRooms = roundDashboard.rooms.reduce((n, r) => n + r.participants.length, 0);
                const byeCount = roundDashboard.byeParticipants.length;
                const disconnected = roundDashboard.rooms.reduce((n, r) => n + r.participants.filter(p => !p.isConnected).length, 0);
                const inLobby = Math.max(0, participants.length - 1 - inRooms - byeCount);
                return (
                  <>
                    <span className="text-gray-600">|</span>
                    <span className="text-green-400">{inRooms} in rooms</span>
                    {inLobby > 0 && <span className="text-blue-400">{inLobby} in main room</span>}
                    {byeCount > 0 && <span className="text-amber-400">{byeCount} waiting</span>}
                    {disconnected > 0 && <span className="text-red-400">{disconnected} disconnected</span>}
                  </>
                );
              })() : sessionStarted && (
                <>
                  <span className="text-gray-600">|</span>
                  <span className="text-blue-400">{Math.max(0, participants.length - 1)} in main room</span>
                </>
              )}
            </div>
            {isInRound && (
              <div className="flex items-center gap-1.5">
                <Radio className="h-3.5 w-3.5 text-red-500 animate-pulse" />
                <span className="text-sm text-gray-700 font-medium">
                  Round {currentRound}/{totalRounds}
                  {phase === 'rating' && ' — Rating'}
                  {isPaused && ' — Paused'}
                </span>
              </div>
            )}
            {!isInRound && sessionStarted && !allRoundsDone && (
              <span className="text-xs text-gray-500">
                {currentRound > 0 ? `After Round ${currentRound}/${totalRounds}` : 'Main Room'}
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
            {sessionStarted && phase === 'lobby' && !allRoundsDone && !matchPreview && (() => {
              const hasActiveRooms = roundDashboard?.rooms.some((r: any) => r.status === 'active');
              const isDuringActiveRound = ['round_active', 'round_rating', 'round_transition'].includes(sessionStatus);
              if (hasActiveRooms || isDuringActiveRound) return (
                <span className="text-xs text-gray-400 px-2 py-1.5 border border-gray-200 rounded-lg cursor-not-allowed" title="End the current round before matching again.">
                  <Shuffle className="h-3.5 w-3.5 inline mr-1 opacity-50" /> Match People
                </span>
              );
              return eligibleCount >= 2 ? (
                <Button size="sm" variant="secondary" onClick={generateMatches} disabled={generating}>
                  {generating ? (
                    <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Matching...</>
                  ) : (
                    <><Shuffle className="h-4 w-4 mr-1" /> Match People</>
                  )}
                </Button>
              ) : (
                <span className="text-xs text-gray-500 px-2 py-1.5 border border-gray-200 rounded-lg">
                  Need {2 - eligibleCount} more participant{eligibleCount === 1 ? '' : 's'} to match
                </span>
              );
            })()}

            {/* After preview: Confirm Matches → Start Round (two-step) */}
            {matchPreview && !matchesConfirmed && (
              <>
                <Button size="sm" onClick={confirmMatches}>
                  <Check className="h-4 w-4 mr-1" /> Confirm Matches
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelPreview}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              </>
            )}
            {matchPreview && matchesConfirmed && (
              <>
                <Button size="sm" onClick={confirmRound} className="animate-pulse">
                  <Play className="h-4 w-4 mr-1" /> Start Round
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelPreview}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              </>
            )}

            {/* Pause/Resume during round */}
            {isInRound && sessionStatus === 'round_active' && (
              <Button size="sm" variant="secondary" onClick={togglePause}>
                {isPaused ? <><Play className="h-4 w-4 mr-1" /> Resume</> : <><Pause className="h-4 w-4 mr-1" /> Pause</>}
              </Button>
            )}

            {/* Extend round by 2 minutes */}
            {isInRound && sessionStatus === 'round_active' && (
              <Button size="sm" variant="secondary" onClick={() => {
                socket?.emit('host:extend_round', { sessionId, additionalSeconds: 120 });
              }} title="Add 2 minutes to the current round">
                <Clock className="h-4 w-4 mr-1" /> +2 min
              </Button>
            )}

            {/* End current round early — moves to rating, NOT end event */}
            {isInRound && sessionStatus === 'round_active' && (
              <Button size="sm" variant="secondary" onClick={endCurrentRound} title="End round early — goes to rating">
                <SkipForward className="h-4 w-4 mr-1" /> End Round
              </Button>
            )}

            {/* Create Room — available any time, hidden when dashboard already shows active rooms */}
            {sessionStarted && (
              <Button size="sm" variant="secondary" onClick={() => { setShowCreateRoom(!showCreateRoom); setCreateRoomSelected(new Set()); }} title="Create a breakout room">
                <UserPlus className="h-4 w-4 mr-1" /> Room
              </Button>
            )}

            {/* Announcement */}
            {sessionStarted && (
              <Button size="sm" variant="ghost" onClick={() => setShowBroadcast(!showBroadcast)} title="Send announcement to all">
                <MessageSquare className="h-4 w-4" />
              </Button>
            )}

            {/* Invite people — opens session page in popup window (host stays in event) */}
            {(sessionStatus === 'lobby_open' || sessionStatus === 'round_transition') && (
              <Button size="sm" variant="secondary" onClick={() => {
                window.open(`/sessions/${sessionId}`, 'rsn-invite', 'width=700,height=700,scrollbars=yes,resizable=yes');
              }}>
                <UserPlus className="h-4 w-4 mr-1" /> Invite
              </Button>
            )}

            <Button size="sm" variant="danger" onClick={endEvent}>
              <Square className="h-4 w-4 mr-1" /> End Event
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
