import { Users, X, Crown, Shield, ShieldCheck } from 'lucide-react';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import Avatar from '@/components/ui/Avatar';
import { getSocket } from '@/lib/socket';

interface Props {
  onClose: () => void;
  sessionId: string;
}

export default function ParticipantList({ onClose, sessionId }: Props) {
  const participants = useSessionStore(s => s.participants);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const cohosts = useSessionStore(s => s.cohosts);
  const { user } = useAuthStore();
  const isOriginalHost = user?.id === hostUserId;

  const toggleCohost = (userId: string) => {
    const socket = getSocket();
    if (!socket) return;
    if (cohosts.has(userId)) {
      socket.emit('host:remove_cohost', { sessionId, userId });
    } else {
      socket.emit('host:assign_cohost', { sessionId, userId, role: 'co_host' });
    }
  };

  // Sort: host first, co-hosts second, then alphabetically
  const sorted = [...participants].sort((a, b) => {
    if (a.userId === hostUserId) return -1;
    if (b.userId === hostUserId) return 1;
    if (cohosts.has(a.userId) && !cohosts.has(b.userId)) return -1;
    if (!cohosts.has(a.userId) && cohosts.has(b.userId)) return 1;
    return (a.displayName || '').localeCompare(b.displayName || '');
  });

  return (
    <div className="flex flex-col h-full bg-[#292a2d] border-l border-white/10">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-400" />
          <h3 className="text-sm font-semibold text-gray-200">Participants</h3>
          <span className="text-xs text-gray-400 bg-white/10 px-2 py-0.5 rounded-full">
            {participants.length}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {sorted.map(p => {
          const isPHost = p.userId === hostUserId;
          const isCohost = cohosts.has(p.userId);
          const isSelf = p.userId === user?.id;

          return (
            <div key={p.userId} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/5 group">
              <a href={`/profile/${p.userId}`} className="flex items-center gap-2.5 flex-1 min-w-0">
                <Avatar name={p.displayName || 'User'} size="sm" />
                <span className="text-sm text-gray-300 truncate">{p.displayName || 'User'}</span>
              </a>
              {isPHost && (
                <span className="flex items-center gap-0.5 text-[10px] font-medium text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                  <Crown className="h-2.5 w-2.5" /> Host
                </span>
              )}
              {isCohost && !isPHost && (
                <span className="flex items-center gap-0.5 text-[10px] font-medium text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                  <ShieldCheck className="h-2.5 w-2.5" /> Co-Host
                </span>
              )}
              {isOriginalHost && !isPHost && !isSelf && (
                <button
                  onClick={() => toggleCohost(p.userId)}
                  title={isCohost ? 'Remove co-host' : 'Make co-host'}
                  className={`p-1 rounded-lg opacity-0 group-hover:opacity-100 transition-all shrink-0 ${
                    isCohost ? 'text-blue-400 hover:bg-blue-500/10' : 'text-gray-500 hover:bg-white/10'
                  }`}
                >
                  <Shield className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {participants.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-4">No participants yet</p>
        )}
      </div>
    </div>
  );
}
