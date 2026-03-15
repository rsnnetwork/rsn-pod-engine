import { useSessionStore } from '@/stores/sessionStore';
import Card from '@/components/ui/Card';
import { Clock, Wifi, WifiOff, UserMinus, Radio, AlertTriangle } from 'lucide-react';
import { getSocket } from '@/lib/socket';

interface Props { sessionId: string; }

export default function HostRoundDashboard({ sessionId }: Props) {
  const { roundDashboard, timerSeconds, currentRound, totalRounds } = useSessionStore();
  const socket = getSocket();

  const removeFromRoom = (matchId: string, userId: string) => {
    if (!confirm('Remove this participant from their current room? Their partner will get a bye.')) return;
    socket?.emit('host:remove_from_room' as any, { sessionId, matchId, userId });
  };

  if (!roundDashboard || roundDashboard.rooms.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center">
          <Radio className="h-8 w-8 text-red-500 animate-pulse mx-auto mb-3" />
          <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Round {currentRound} of {totalRounds}</h2>
          <p className="text-gray-500 text-sm">Setting up breakout rooms...</p>
        </Card>
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
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Radio className="h-4 w-4 text-red-500 animate-pulse" />
            <h2 className="text-lg font-bold text-[#1a1a2e]">
              Round {currentRound} of {totalRounds}
            </h2>
            <span className="text-sm text-gray-400">
              {activeRooms.length} room{activeRooms.length !== 1 ? 's' : ''} active
            </span>
          </div>
          <div className="flex items-center gap-2 text-lg font-mono font-bold text-[#1a1a2e]">
            <Clock className="h-5 w-5 text-gray-400" />
            {formatTime(timerSeconds)}
          </div>
        </div>

        {/* Breakout Rooms Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {roundDashboard.rooms.map((room, idx) => (
            <Card key={room.matchId} className={`!p-3 ${room.status === 'no_show' ? 'opacity-60 border-red-200' : room.status === 'active' ? 'border-green-200' : 'border-gray-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-500 uppercase">
                  Room {idx + 1}
                  {room.isTrio && <span className="ml-1 text-rsn-red">(Trio)</span>}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  room.status === 'active' ? 'bg-green-50 text-green-600' :
                  room.status === 'no_show' ? 'bg-red-50 text-red-500' :
                  room.status === 'completed' ? 'bg-gray-100 text-gray-500' :
                  'bg-amber-50 text-amber-600'
                }`}>
                  {room.status === 'active' ? 'Live' : room.status === 'no_show' ? 'Disconnected' : room.status}
                </span>
              </div>
              <div className="space-y-1.5">
                {room.participants.map(p => (
                  <div key={p.userId} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {p.isConnected ? (
                        <Wifi className="h-3 w-3 text-green-500" />
                      ) : (
                        <WifiOff className="h-3 w-3 text-red-400" />
                      )}
                      <span className={`text-sm ${p.isConnected ? 'text-gray-800' : 'text-gray-400'}`}>
                        {p.displayName}
                      </span>
                    </div>
                    {room.status === 'active' && (
                      <button
                        onClick={() => removeFromRoom(room.matchId, p.userId)}
                        className="p-1 text-gray-300 hover:text-red-400 transition-colors rounded"
                        title={`Remove ${p.displayName} from room`}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>

        {/* Bye Participants */}
        {roundDashboard.byeParticipants.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="text-sm text-amber-700">
              Bye this round: {roundDashboard.byeParticipants.map(p => p.displayName).join(', ')}
            </span>
          </div>
        )}

        {/* Reassignment indicator */}
        {roundDashboard.reassignmentInProgress && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-rsn-red-light border border-rsn-red-200">
            <Radio className="h-4 w-4 text-rsn-red animate-pulse" />
            <span className="text-sm text-rsn-red-hover">Reassignment in progress...</span>
          </div>
        )}
      </div>
    </div>
  );
}
