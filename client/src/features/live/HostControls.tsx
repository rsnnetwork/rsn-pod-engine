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
  // Unified breakout-room creation modal (replaces separate "Room" + "Bulk" buttons).
  // Always submits via host:create_breakout_bulk — single-room is N=1.
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [roomDuration, setRoomDuration] = useState(300);
  const [roomVisibility, setRoomVisibility] = useState<'visible' | 'hidden'>('visible');
  const [roomRows, setRoomRows] = useState<Array<Set<string>>>([new Set()]); // array of room-participant sets
  const [bulkDurationEdit, setBulkDurationEdit] = useState(false);
  const [bulkDurationValue, setBulkDurationValue] = useState(300);

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

  // Manual breakout controls — counts active manual rooms (is_manual=TRUE on server)
  const hasActiveManualRooms = !!roundDashboard?.rooms.some(
    (r: any) => r.status === 'active' && r.isManual,
  );
  const activeManualCount = roundDashboard?.rooms.filter(
    (r: any) => r.status === 'active' && r.isManual,
  ).length || 0;

  // Bug 5 (April 18 Dr Arch): Round-control visibility / Match-People enable
  // must derive from LIVE algorithm-match state, not from session.status alone.
  //
  // Why session.status is not enough:
  //   1. Pause/+2/End Round were gated on session.status === 'round_active'
  //      → they vanished during 'round_transition' even when an algorithm
  //      round was still running on the wire (state-mismatch / mid-flight).
  //   2. Match People was disabled on session.status === 'round_transition'
  //      → but handleHostGenerateMatches (matching-flow.ts:60) explicitly
  //      ALLOWS round_transition; that's exactly when the host generates
  //      round 2's matches. The over-aggressive disable blocked the legit
  //      "start next round" path.
  //
  // hasActiveAlgorithmRound is the ONE source of truth for both. The dashboard
  // is server-emitted on every match transition (round-lifecycle.ts:274,414,
  // 421,453,1026), so the client's view of `rooms[].status === 'active' &&
  // !isManual` lags by at most one socket round-trip from the DB.
  const hasActiveAlgorithmRound = !!roundDashboard?.rooms.some(
    (r: any) => r.status === 'active' && !r.isManual,
  );

  const submitRoomCreate = () => {
    const roomsPayload = roomRows
      .filter(s => s.size >= 1)
      .map(s => ({ participantIds: Array.from(s) }));
    if (roomsPayload.length === 0) {
      alert('Add at least one participant to a room.');
      return;
    }
    // Always use bulk endpoint — N=1 is just a degenerate bulk case.
    // This unifies the code path for single + multi-room creation.
    socket?.emit('host:create_breakout_bulk' as any, {
      sessionId,
      rooms: roomsPayload,
      sharedDurationSeconds: roomDuration || 0,
      timerVisibility: roomVisibility,
    });
    setShowRoomModal(false);
    setRoomRows([new Set()]);
  };

  const bulkExtendAll = () => {
    socket?.emit('host:extend_breakout_all' as any, { sessionId, additionalSeconds: 120 });
  };

  const bulkEndAll = () => {
    if (!confirm(`End all ${activeManualCount} manual breakout rooms? Participants will move to rating.`)) return;
    socket?.emit('host:end_breakout_all' as any, { sessionId });
  };

  const bulkSetDurationAll = () => {
    socket?.emit('host:set_breakout_duration_all' as any, { sessionId, durationSeconds: bulkDurationValue });
    setBulkDurationEdit(false);
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

      {/* Unified breakout-room creation modal — replaces the old "Room" + "Bulk" buttons.
          Always submits via host:create_breakout_bulk (N=1 is a degenerate bulk). */}
      {showRoomModal && (
        <div className="border-b border-gray-200 bg-emerald-50 px-4 py-3">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-emerald-700 flex items-center gap-2">
                <UserPlus className="h-4 w-4" /> Create breakout rooms
              </h3>
              <button onClick={() => { setShowRoomModal(false); setRoomRows([new Set()]); }} className="text-xs text-gray-500 hover:text-gray-700">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Shared duration + visibility */}
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <label className="text-xs text-gray-600 font-medium">Duration:</label>
              <select
                value={roomDuration}
                onChange={e => setRoomDuration(Number(e.target.value))}
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
              <label className="text-xs text-gray-600 font-medium ml-2">Timer:</label>
              <select
                value={roomVisibility}
                onChange={e => setRoomVisibility(e.target.value as 'visible' | 'hidden')}
                className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-900 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              >
                <option value="visible">Visible to participants</option>
                <option value="hidden">Hidden from participants</option>
              </select>
            </div>

            {/* Room rows — assign participants to each. Start with 1 row, "+ Add room" appends. */}
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {roomRows.map((roomSet, idx) => {
                const usedIds = new Set<string>();
                roomRows.forEach((s, i) => { if (i !== idx) s.forEach(id => usedIds.add(id)); });
                return (
                  <div key={idx} className="bg-white border border-emerald-200 rounded-lg p-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-emerald-700">Room {idx + 1} — {roomSet.size} participant{roomSet.size !== 1 ? 's' : ''}</span>
                      {roomRows.length > 1 && (
                        <button
                          onClick={() => setRoomRows(prev => prev.filter((_, i) => i !== idx))}
                          className="text-[10px] text-red-500 hover:text-red-700"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                      {participants
                        .filter(p => p.userId !== hostUserId && !cohosts.has(p.userId))
                        .map(p => {
                          const selected = roomSet.has(p.userId);
                          const usedElsewhere = !selected && usedIds.has(p.userId);
                          const inActiveRoom = !selected && !usedElsewhere && roundDashboard?.rooms.some(
                            r => r.status === 'active' && r.participants.some(rp => rp.userId === p.userId)
                          );
                          return (
                            <label
                              key={p.userId}
                              className={`flex items-center gap-1 text-[11px] px-1.5 py-1 rounded cursor-pointer transition-colors ${
                                selected ? 'bg-emerald-100 border border-emerald-300' :
                                usedElsewhere ? 'bg-gray-100 border border-gray-200 opacity-50 cursor-not-allowed' :
                                inActiveRoom ? 'bg-blue-50 border border-blue-200' :
                                'bg-gray-50 border border-gray-200 hover:bg-emerald-50'
                              } ${roomSet.size >= 3 && !selected ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={usedElsewhere || (roomSet.size >= 3 && !selected)}
                                onChange={() => {
                                  setRoomRows(prev => prev.map((s, i) => {
                                    if (i !== idx) return s;
                                    const next = new Set(s);
                                    if (next.has(p.userId)) next.delete(p.userId);
                                    else if (next.size < 3) next.add(p.userId);
                                    return next;
                                  }));
                                }}
                                className="h-3 w-3 rounded border-gray-300 text-emerald-500 focus:ring-emerald-400"
                              />
                              <span className="truncate text-gray-700">{p.displayName}</span>
                              {inActiveRoom && <span className="text-[10px] text-blue-500 shrink-0">(in room)</span>}
                            </label>
                          );
                        })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2 mt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRoomRows(prev => [...prev, new Set()])}
                disabled={roomRows.length >= 25}
              >
                <UserPlus className="h-3.5 w-3.5 mr-1" /> Add room
              </Button>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setShowRoomModal(false); setRoomRows([new Set()]); }}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={roomRows.every(s => s.size === 0)}
                  onClick={submitRoomCreate}
                >
                  Create ({roomRows.filter(s => s.size >= 1).length})
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Task 14 — Bulk "Set Duration" mini-panel */}
      {bulkDurationEdit && (
        <div className="border-b border-gray-200 bg-purple-50 px-4 py-2">
          <div className="max-w-4xl mx-auto flex items-center gap-2">
            <label className="text-xs text-gray-600 font-medium">Set duration for all manual rooms:</label>
            <select
              value={bulkDurationValue}
              onChange={e => setBulkDurationValue(Number(e.target.value))}
              className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-900 focus:outline-none focus:ring-1 focus:ring-purple-400"
            >
              <option value={180}>3 min</option>
              <option value={300}>5 min</option>
              <option value={600}>10 min</option>
              <option value={900}>15 min</option>
              <option value={1200}>20 min</option>
              <option value={1800}>30 min</option>
            </select>
            <Button size="sm" onClick={bulkSetDurationAll}>Apply to all</Button>
            <Button size="sm" variant="ghost" onClick={() => setBulkDurationEdit(false)}>
              <X className="h-3.5 w-3.5" />
            </Button>
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

            {/* Two-step breakout: Match People → preview → Start Round.
                Bug 5 (April 18 Dr Arch): disable rule now derives from LIVE
                algorithm-match state, not session.status. Server allows
                generate_matches in both LOBBY_OPEN and ROUND_TRANSITION
                (matching-flow.ts:60-69), so disabling on round_transition
                blocked the legit "start next round" path. The new rule
                disables only when an algorithm round is actually running
                or there aren't enough eligible participants. */}
            {sessionStarted && phase === 'lobby' && !allRoundsDone && !matchPreview && (() => {
              // Server-computed count of participants in the main room (not in any
              // active match — manual or algorithm). Falls back to client-side
              // count if dashboard not loaded yet.
              const eligibleMainRoomCount = (roundDashboard as any)?.eligibleMainRoomCount ?? eligibleCount;
              const matchPeopleDisabled = hasActiveAlgorithmRound || eligibleMainRoomCount < 2;
              const matchPeopleHint = hasActiveAlgorithmRound
                ? 'A round is in progress — wait for it to end'
                : eligibleMainRoomCount < 2
                ? `Need at least 2 participants in main room (currently ${eligibleMainRoomCount})`
                : '';
              if (matchPeopleDisabled) {
                return (
                  <span
                    className="text-xs text-gray-500 px-2 py-1.5 border border-gray-200 rounded-lg cursor-not-allowed inline-flex items-center gap-1"
                    title={matchPeopleHint}
                  >
                    <Shuffle className="h-3.5 w-3.5 opacity-50" /> Match People
                  </span>
                );
              }
              return (
                <Button size="sm" variant="secondary" onClick={generateMatches} disabled={generating}>
                  {generating ? (
                    <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Matching...</>
                  ) : (
                    <><Shuffle className="h-4 w-4 mr-1" /> Match People</>
                  )}
                </Button>
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

            {/* Pause/Resume during round.
                Bug 5: visibility now derives from live algorithm-match state
                instead of session.status === 'round_active'. The server-side
                guards (host-actions.ts handlePauseSession etc.) gate on the
                actual session state, so showing the button when an algorithm
                round is in flight — even mid-transition — is safe. */}
            {hasActiveAlgorithmRound && (
              <Button size="sm" variant="secondary" onClick={togglePause}>
                {isPaused ? <><Play className="h-4 w-4 mr-1" /> Resume</> : <><Pause className="h-4 w-4 mr-1" /> Pause</>}
              </Button>
            )}

            {/* Extend round by 2 minutes — same live-state rule */}
            {hasActiveAlgorithmRound && (
              <Button size="sm" variant="secondary" onClick={() => {
                socket?.emit('host:extend_round', { sessionId, additionalSeconds: 120 });
              }} title="Add 2 minutes to the current round">
                <Clock className="h-4 w-4 mr-1" /> +2 min
              </Button>
            )}

            {/* End current round early — moves to rating, NOT end event.
                handleHostEnd (host-actions.ts:434) detects ROUND_ACTIVE and
                routes to endRound() → rating window flow. */}
            {hasActiveAlgorithmRound && (
              <Button size="sm" variant="secondary" onClick={endCurrentRound} title="End round early — goes to rating">
                <SkipForward className="h-4 w-4 mr-1" /> End Round
              </Button>
            )}

            {/* Room — opens unified modal (single or multiple breakout rooms with shared timer).
                Replaces the old separate "Room" + "Bulk" buttons. */}
            {sessionStarted && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => { setShowRoomModal(!showRoomModal); setRoomRows([new Set()]); }}
                title="Create one or more breakout rooms"
              >
                <UserPlus className="h-4 w-4 mr-1" /> Room
              </Button>
            )}

            {/* Task 14 — Bulk controls: only show when manual rooms are active */}
            {sessionStarted && hasActiveManualRooms && (
              <>
                <Button size="sm" variant="secondary" onClick={bulkExtendAll} title={`Add 2 minutes to all ${activeManualCount} manual rooms`}>
                  <Clock className="h-4 w-4 mr-1" /> +2 all
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setBulkDurationEdit(!bulkDurationEdit)} title="Set shared duration for all manual rooms">
                  <Clock className="h-4 w-4 mr-1" /> Set
                </Button>
                <Button size="sm" variant="danger" onClick={bulkEndAll} title={`End all ${activeManualCount} manual rooms`}>
                  <Square className="h-4 w-4 mr-1" /> End all
                </Button>
              </>
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
