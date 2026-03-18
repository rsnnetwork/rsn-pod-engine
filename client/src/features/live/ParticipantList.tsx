import { Users, X, Crown } from 'lucide-react';
import { useSessionStore } from '@/stores/sessionStore';
import Avatar from '@/components/ui/Avatar';

interface Props {
  onClose: () => void;
}

export default function ParticipantList({ onClose }: Props) {
  const participants = useSessionStore(s => s.participants);
  const hostUserId = useSessionStore(s => s.hostUserId);

  // Sort: host first, then alphabetically
  const sorted = [...participants].sort((a, b) => {
    if (a.userId === hostUserId) return -1;
    if (b.userId === hostUserId) return 1;
    return (a.displayName || '').localeCompare(b.displayName || '');
  });

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50/80">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-700">Participants</h3>
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            {participants.length}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {sorted.map(p => (
          <div key={p.userId} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-gray-50">
            <Avatar name={p.displayName || 'User'} size="sm" />
            <span className="text-sm text-gray-700 truncate flex-1">{p.displayName || 'User'}</span>
            {p.userId === hostUserId && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">
                <Crown className="h-2.5 w-2.5" /> Host
              </span>
            )}
          </div>
        ))}
        {participants.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-4">No participants yet</p>
        )}
      </div>
    </div>
  );
}
