import { useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { Clock, Wifi, WifiOff, UserMinus, Radio, AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { getSocket } from '@/lib/socket';

interface Props { sessionId: string; }

export default function HostRoundDashboard({ sessionId }: Props) {
  const { roundDashboard, timerSeconds, currentRound, totalRounds } = useSessionStore();
  const socket = getSocket();
  const [moveMode, setMoveMode] = useState<{ userId: string; fromMatchId: string; displayName: string } | null>(null);

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

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 bg-white">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Radio className="h-4 w-4 text-red-500 animate-pulse" />
            <h2 className="text-lg font-bold text-[#1a1a2e]">
              {currentRound > 0 ? `Round ${currentRound} of ${totalRounds}` : 'Breakout Rooms'}
            </h2>
            <span className="text-sm text-gray-500">
              {activeRooms.length} room{activeRooms.length !== 1 ? 's' : ''} active
            </span>
          </div>
          {currentRound > 0 && timerSeconds > 0 && (
            <div className="flex items-center gap-2 text-lg font-mono font-bold text-[#1a1a2e]">
              <Clock className="h-5 w-5 text-gray-400" />
              {formatTime(timerSeconds)}
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

        {/* Breakout Rooms Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {roundDashboard.rooms.map((room, idx) => {
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
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-500 uppercase">
                    Room {idx + 1}
                    {room.isTrio && <span className="ml-1 text-blue-500">(Trio)</span>}
                    {(room as any).isManual && <span className="ml-1 text-purple-500">(Manual)</span>}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    room.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                    room.status === 'no_show' ? 'bg-red-100 text-red-600' :
                    room.status === 'completed' ? 'bg-gray-100 text-gray-500' :
                    'bg-amber-100 text-amber-700'
                  }`}>
                    {room.status === 'active' ? 'Live' : room.status === 'no_show' ? 'Disconnected' : room.status}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {room.participants.map(p => (
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
                {/* Per-room +2 min extend — only for manual breakout rooms with custom timer */}
                {room.status === 'active' && !moveMode && (room as any).isManual && (
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
          })}
        </div>

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
