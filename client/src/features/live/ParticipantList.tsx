import { Users, X, Crown, Shield, ShieldCheck } from 'lucide-react';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import Avatar from '@/components/ui/Avatar';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';

interface Props {
  onClose: () => void;
  sessionId: string;
}

export default function ParticipantList({ onClose, sessionId }: Props) {
  const participants = useSessionStore(s => s.participants);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const cohosts = useSessionStore(s => s.cohosts);
  // Phase P (Ali's 13 May clarification) — badges + sort must respect
  // acting_as_host: admin/super_admin opt-ins show as Co-Host;
  // cohost/super_admin opt-outs lose their Co-Host badge.
  const actingAsHostOverrides = useSessionStore(s => s.actingAsHostOverrides);
  const { user } = useAuthStore();
  const isOriginalHost = user?.id === hostUserId;

  // Helper: is this user currently acting as a co-host/host (not counting
  // the director who has their own "Host" badge)?
  const isActingCohost = (uid: string): boolean => {
    if (uid === hostUserId) return false; // director gets the Host badge, not Co-Host
    const override = actingAsHostOverrides[uid];
    if (override === false) return false; // explicit opt-out
    if (override === true) return true; // explicit opt-in
    return cohosts.has(uid); // default cohost membership
  };

  const addToast = useToastStore(s => s.addToast);
  // Bug 3 (13 May live test) — co-host can be promoted via two paths and
  // the participant-list toggle only walked one of them. When an admin
  // opted in via the "Join as host" banner (Phase M acting_as_host=true)
  // they showed the Co-Host badge but clicking the shield button emitted
  // host:remove_cohost which is a no-op because they were never in
  // session_cohosts. The badge stuck. Now the demote path clears
  // whichever path is in effect: session_cohosts via socket AND/OR
  // acting_as_host=false via the host-initiated REST endpoint. Promote
  // stays on the formal session_cohosts path because it works for any
  // role (Phase M acting_as_host requires admin/super_admin base role).
  const toggleCohost = async (userId: string) => {
    const socket = getSocket();
    const formallyACohost = cohosts.has(userId);
    const optedIn = actingAsHostOverrides[userId] === true;
    const currentlyACohost = isActingCohost(userId);

    if (currentlyACohost) {
      if (formallyACohost) {
        socket?.emit('host:remove_cohost', { sessionId, userId });
      }
      if (optedIn) {
        try {
          await api.post(`/sessions/${sessionId}/host/acting-as-host-for/${userId}`, { value: false });
        } catch {
          addToast("Couldn't demote this co-host. Try again.", 'error');
        }
      }
    } else {
      socket?.emit('host:assign_cohost', { sessionId, userId, role: 'co_host' });
    }
  };

  // Sort: host first, co-hosts second (including Phase P opt-ins), then alphabetically.
  const sorted = [...participants].sort((a, b) => {
    if (a.userId === hostUserId) return -1;
    if (b.userId === hostUserId) return 1;
    const aIsCohost = isActingCohost(a.userId);
    const bIsCohost = isActingCohost(b.userId);
    if (aIsCohost && !bIsCohost) return -1;
    if (!aIsCohost && bIsCohost) return 1;
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
          className="p-1 text-gray-400 hover:text-gray-900 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {sorted.map(p => {
          const isPHost = p.userId === hostUserId;
          const isCohost = isActingCohost(p.userId);
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
              {/* Bug 13 (13 May live test) — original rule said only the
                  admin themselves could untoggle Phase M opt-in.
                  Bug 43 (19 May Ali) overrides that: director's supreme-
                  host authority (Bug 2 principle) covers Phase M cohosts
                  too. toggleCohost already handles both code paths
                  (host:remove_cohost socket emit for formal cohosts +
                  acting-as-host-for REST clear for opt-ins), so removing
                  the isViaPhaseM gate is enough — the button is safe to
                  show, and clicking it does the right thing for any
                  cohost the director sees. */}
              {(() => {
                if (!isOriginalHost || isPHost || isSelf) return null;
                // Bug 38 (19 May Ali) — was opacity-0 group-hover:opacity-100,
                // which hid the toggle entirely on mobile (no hover) and made
                // it easy to miss on desktop. Now always visible so the
                // director can demote/promote cohosts directly from the
                // Participants drawer without opening the full HCC modal.
                return (
                  <button
                    onClick={() => toggleCohost(p.userId)}
                    title={isCohost ? 'Remove co-host' : 'Make co-host'}
                    aria-label={isCohost ? `Remove ${p.displayName || 'user'} as co-host` : `Make ${p.displayName || 'user'} a co-host`}
                    className={`p-1.5 rounded-lg transition-colors shrink-0 ${
                      isCohost ? 'text-blue-400 hover:bg-blue-500/10' : 'text-gray-400 hover:bg-white/10'
                    }`}
                  >
                    <Shield className="h-4 w-4" />
                  </button>
                );
              })()}
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
