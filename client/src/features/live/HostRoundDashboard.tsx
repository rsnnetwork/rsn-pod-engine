import { useState, useEffect } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { Clock, Wifi, WifiOff, UserMinus, Radio, AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { getSocket } from '@/lib/socket';

interface Props { sessionId: string; }

// Bug 18 (April 19) — compute remaining seconds from a server-sent
// ISO endsAt string. Uses CLIENT clock (not server's) — paired with
// the dashboard's per-room endsAt which is itself computed against
// the server clock at emit time. Sub-second drift only.
function remainingSeconds(endsAtIso: string | null | undefined): number {
  if (!endsAtIso) return 0;
  const ms = new Date(endsAtIso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

function formatMSS(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function HostRoundDashboard({ sessionId }: Props) {
  // Bug 8.7 (April 19) — selector pattern (was destructuring whole store).
  // Whole-store reads make this component re-render on EVERY field change
  // (timer tick, participant updates, dashboard refresh). With selectors,
  // only the actually-used fields trigger re-renders.
  const roundDashboard = useSessionStore(s => s.roundDashboard);
  const timerSeconds = useSessionStore(s => s.timerSeconds);
  const isPaused = useSessionStore(s => s.isPaused);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const socket = getSocket();
  const [moveMode, setMoveMode] = useState<{ userId: string; fromMatchId: string; displayName: string } | null>(null);
  // Bug 18 — local 1s tick so per-manual-room timers re-render. This
  // is independent of the session-level timerSeconds; manual rooms each
  // have their own endsAt and we recompute on tick.
  const [, setNow] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Phase 8 (1 May spec) — host action receipts.
  // Server emits host:action_confirmed after destructive/state-changing
  // actions. We render a transient toast (3s) and keep the last 5 in an
  // audit strip so the host can always see "what just happened".
  const [actionLog, setActionLog] = useState<{ id: string; summary: string; ts: number }[]>([]);
  useEffect(() => {
    if (!socket) return;
    const handler = (payload: { sessionId: string; action: string; summary: string; timestamp: string }) => {
      if (payload.sessionId !== sessionId) return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setActionLog(prev => [{ id, summary: payload.summary, ts: Date.now() }, ...prev].slice(0, 5));
      // Auto-fade after 3 seconds.
      setTimeout(() => {
        setActionLog(prev => prev.filter(e => e.id !== id));
      }, 3000);
    };
    socket.on('host:action_confirmed' as any, handler);
    return () => { socket.off('host:action_confirmed' as any, handler); };
  }, [socket, sessionId]);

  const removeFromRoom = (matchId: string, userId: string) => {
    if (!confirm('Remove this participant from their current room? Their partner will be unmatched.')) return;
    socket?.emit('host:remove_from_room' as any, { sessionId, matchId, userId });
  };

  const extendBreakoutRoom = (matchId: string) => {
    socket?.emit('host:extend_breakout_room' as any, {
      sessionId,
      matchId,
      additionalSeconds: 120,
    });
  };

  const moveToRoom = (targetMatchId: string) => {
    if (!moveMode) return;
    if (!confirm(`Move ${moveMode.displayName} to this room?`)) return;
    socket?.emit('host:move_to_room' as any, {
      sessionId,
      userId: moveMode.userId,
      targetMatchId,
    });
    setMoveMode(null);
  };

  if (!roundDashboard || roundDashboard.rooms.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-white">
        <div className="max-w-md w-full text-center bg-gray-50 rounded-2xl p-8">
          <Radio className="h-8 w-8 text-red-500 animate-pulse mx-auto mb-3" />
          <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">{currentRound > 0 ? `Round ${currentRound} of ${totalRounds}` : 'Breakout Rooms'}</h2>
          <p className="text-gray-500 text-sm">Setting up breakout rooms...</p>
        </div>
      </div>
    );
  }

  const activeRooms = roundDashboard.rooms.filter(r => r.status === 'active');
  // Bug 18 — split active rooms into algorithm vs manual. Each section
  // owns its own timer state. Manual on the LEFT, algorithm on the RIGHT
  // per the approved 2-column design.
  const activeAlgorithmRooms = activeRooms.filter(r => !(r as any).isManual);
  const activeManualRooms = activeRooms.filter(r => (r as any).isManual);
  const isAlgorithmActive = activeAlgorithmRooms.length > 0;
  const isManualActive = activeManualRooms.length > 0;
  const showSplit = isAlgorithmActive && isManualActive;

  // Detect "all manual rooms share the same duration" by checking if every
  // active manual room's roomEndsAt is within ±5s of the others. If yes,
  // we can render ONE shared header timer for the manual section. If
  // durations vary, we render per-room timers next to each card.
  const manualRoomEndsAtTimes = activeManualRooms
    .map((r: any) => r.roomEndsAt ? new Date(r.roomEndsAt).getTime() : null)
    .filter((t): t is number => t !== null);
  const manualSharedEndsAt = (() => {
    if (manualRoomEndsAtTimes.length === 0) return null;
    const min = Math.min(...manualRoomEndsAtTimes);
    const max = Math.max(...manualRoomEndsAtTimes);
    if (max - min <= 5000) return new Date(min); // within 5s tolerance
    return null;
  })();
  const manualHasAnyTimer = activeManualRooms.some((r: any) => r.roomEndsAt);

  return (
    <div className="flex-1 overflow-y-auto p-4 bg-white">
      {/* Phase 8 (1 May spec) — host action receipts.
          Floating toast stack so the host knows their last action(s)
          actually landed. 3-second auto-fade per entry. */}
      {actionLog.length > 0 && (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-xs">
          {actionLog.map(entry => (
            <div
              key={entry.id}
              className="bg-white border border-emerald-200 shadow-lg rounded-lg px-3 py-2 text-sm text-[#1a1a2e] flex items-center gap-2 animate-fade-in"
              role="status"
            >
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 flex-shrink-0" />
              <span className="truncate">{entry.summary}</span>
            </div>
          ))}
        </div>
      )}
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Header — only show the global round timer when an ALGORITHM round is
            actually active. Manual-only state hides the global timer entirely
            (each manual room owns its own time, shown in its own section). */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Radio className="h-4 w-4 text-red-500 animate-pulse" />
            <h2 className="text-lg font-bold text-[#1a1a2e]">
              {isAlgorithmActive && currentRound > 0
                ? `Round ${currentRound} of ${totalRounds}`
                : isManualActive
                ? 'Manual Breakouts'
                : 'Breakout Rooms'}
            </h2>
            <span className="text-sm text-gray-500">
              {activeRooms.length} room{activeRooms.length !== 1 ? 's' : ''} active
            </span>
          </div>
          {/* Bug 18 — global top-right timer ONLY for algorithm round.
              Hidden when only manual breakouts are active so the manual
              room timer doesn't bleed into this slot. */}
          {isAlgorithmActive && currentRound > 0 && timerSeconds > 0 && (
            <div className="flex items-center gap-2 text-lg font-mono font-bold text-[#1a1a2e]">
              <Clock className="h-5 w-5 text-gray-400" />
              {formatMSS(timerSeconds)}
              {isPaused && <span className="text-xs text-amber-500 font-sans font-medium ml-1">paused</span>}
            </div>
          )}
        </div>

        {/* Move mode banner */}
        {moveMode && (
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-blue-50 border border-blue-200">
            <span className="text-sm text-blue-700">
              Select a room to move <strong>{moveMode.displayName}</strong> to
            </span>
            <button onClick={() => setMoveMode(null)} className="text-xs text-blue-500 hover:text-blue-700 font-medium">
              Cancel
            </button>
          </div>
        )}

        {/* Bug 11 + Bug 18 (April 19) — split-column layout when BOTH
            algorithm and manual breakouts are active. Manual on the LEFT
            with its own timer header (shared if all same duration, per-
            room otherwise). Algorithm on the RIGHT with its own header
            (uses the session round timer). When only one type is active,
            falls back to a single-column grid for that type. */}
        {(() => {
          const renderRoomCard = (room: any, idx: number, options: { showInlineTimer?: boolean } = {}) => {
            const isTargetCandidate = moveMode && room.matchId !== moveMode.fromMatchId && room.status === 'active';
            return (
              <div
                key={room.matchId}
                onClick={isTargetCandidate ? () => moveToRoom(room.matchId) : undefined}
                className={`rounded-xl p-3 transition-all ${
                  isTargetCandidate
                    ? 'bg-blue-50 border-2 border-blue-400 cursor-pointer hover:bg-blue-100'
                    : room.status === 'no_show'
                      ? 'opacity-60 bg-red-50 border border-red-200'
                      : room.status === 'active'
                        ? 'bg-gray-50 border border-emerald-200'
                        : 'bg-gray-50 border border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between mb-2 gap-2">
                  <span className="text-xs font-semibold text-gray-500 uppercase">
                    Room {idx + 1}
                    {room.isTrio && <span className="ml-1 text-blue-500">(Trio)</span>}
                    {room.isManual && <span className="ml-1 text-purple-500">(Manual)</span>}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {/* Bug 18 — inline per-room timer when manual durations vary
                        (showInlineTimer=true). When all manual rooms share the
                        same duration, the section header shows the timer instead. */}
                    {options.showInlineTimer && room.roomEndsAt && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-gray-700">
                        <Clock className="h-3 w-3 text-gray-400" />
                        {formatMSS(remainingSeconds(room.roomEndsAt))}
                      </span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      room.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                      room.status === 'no_show' ? 'bg-red-100 text-red-600' :
                      room.status === 'completed' ? 'bg-gray-100 text-gray-500' :
                      'bg-amber-100 text-amber-700'
                    }`}>
                      {room.status === 'active' ? 'Live' : room.status === 'no_show' ? 'Disconnected' : room.status}
                    </span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {room.participants.map((p: any) => (
                    <div key={p.userId} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {p.isConnected ? (
                          <Wifi className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <WifiOff className="h-3 w-3 text-red-400" />
                        )}
                        <span className={`text-sm ${p.isConnected ? 'text-gray-700' : 'text-gray-400'}`}>
                          {p.displayName}
                        </span>
                      </div>
                      {room.status === 'active' && !moveMode && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setMoveMode({ userId: p.userId, fromMatchId: room.matchId, displayName: p.displayName }); }}
                            className="p-1 text-gray-400 hover:text-blue-500 transition-colors rounded"
                            title={`Move ${p.displayName} to another room`}
                          >
                            <ArrowRightLeft className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeFromRoom(room.matchId, p.userId); }}
                            className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded"
                            title={`Remove ${p.displayName} from room`}
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {isTargetCandidate && (
                  <p className="text-xs text-blue-500 text-center mt-2 font-medium">Click to move here</p>
                )}
                {room.status === 'active' && !moveMode && room.isManual && (
                  <div className="flex justify-end mt-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); extendBreakoutRoom(room.matchId); }}
                      className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1 border border-gray-200 rounded inline-flex items-center gap-1"
                      title="Add 2 minutes to this room's timer"
                    >
                      <Clock className="h-3 w-3" /> +2 min
                    </button>
                  </div>
                )}
              </div>
            );
          };

          // ── Section header components ───────────────────────────────────
          const ManualSectionHeader = () => (
            <div className="flex items-center justify-between gap-2 px-2 py-2 rounded-lg bg-purple-50 border border-purple-200">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-purple-600" />
                <h3 className="text-sm font-semibold text-purple-900">Manual Breakouts</h3>
                <span className="text-xs text-purple-600">
                  {activeManualRooms.length} room{activeManualRooms.length !== 1 ? 's' : ''}
                </span>
              </div>
              {/* Shared timer if every manual room has the same endsAt */}
              {manualSharedEndsAt && (
                <span className="inline-flex items-center gap-1 text-sm font-mono font-semibold text-purple-900">
                  <Clock className="h-4 w-4 text-purple-500" />
                  {formatMSS(remainingSeconds(manualSharedEndsAt.toISOString()))}
                </span>
              )}
              {!manualSharedEndsAt && manualHasAnyTimer && (
                <span className="text-[11px] text-purple-600 font-medium">per-room timer</span>
              )}
              {!manualHasAnyTimer && (
                <span className="text-[11px] text-purple-500 italic">no time limit</span>
              )}
            </div>
          );

          const AlgorithmSectionHeader = () => (
            <div className="flex items-center justify-between gap-2 px-2 py-2 rounded-lg bg-emerald-50 border border-emerald-200">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-emerald-600 animate-pulse" />
                <h3 className="text-sm font-semibold text-emerald-900">
                  Algorithm Round {currentRound > 0 ? `${currentRound} of ${totalRounds}` : ''}
                </h3>
                <span className="text-xs text-emerald-600">
                  {activeAlgorithmRooms.length} room{activeAlgorithmRooms.length !== 1 ? 's' : ''}
                </span>
              </div>
              {timerSeconds > 0 && (
                <span className="inline-flex items-center gap-1 text-sm font-mono font-semibold text-emerald-900">
                  <Clock className="h-4 w-4 text-emerald-500" />
                  {formatMSS(timerSeconds)}
                  {isPaused && <span className="text-[10px] text-amber-600 font-sans ml-1">paused</span>}
                </span>
              )}
            </div>
          );

          // ── Layout: 2 columns when both active, 1 column when only one ──
          if (showSplit) {
            return (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Manual on the LEFT (per user's design preference) */}
                <div className="space-y-3">
                  <ManualSectionHeader />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {activeManualRooms.map((r, i) => renderRoomCard(r, i, { showInlineTimer: !manualSharedEndsAt }))}
                  </div>
                </div>
                {/* Algorithm on the RIGHT */}
                <div className="space-y-3">
                  <AlgorithmSectionHeader />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {activeAlgorithmRooms.map((r, i) => renderRoomCard(r, i))}
                  </div>
                </div>
              </div>
            );
          }

          // Only one type active — single column with that section's header
          if (isManualActive) {
            return (
              <div className="space-y-3">
                <ManualSectionHeader />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {activeManualRooms.map((r, i) => renderRoomCard(r, i, { showInlineTimer: !manualSharedEndsAt }))}
                </div>
              </div>
            );
          }
          if (isAlgorithmActive) {
            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {activeAlgorithmRooms.map((r, i) => renderRoomCard(r, i))}
              </div>
            );
          }
          // Neither active (shouldn't happen — handled by the early return above)
          return null;
        })()}

        {/* Bye Participants */}
        {roundDashboard.byeParticipants.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="text-sm text-amber-700">
              Not matched this round: {roundDashboard.byeParticipants.map(p => p.displayName).join(', ')}
            </span>
          </div>
        )}

        {/* Reassignment indicator */}
        {roundDashboard.reassignmentInProgress && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200">
            <Radio className="h-4 w-4 text-blue-500 animate-pulse" />
            <span className="text-sm text-blue-600">Reassignment in progress...</span>
          </div>
        )}
      </div>
    </div>
  );
}
