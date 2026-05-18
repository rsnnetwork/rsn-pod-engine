// ─── Chat Quick Access ──────────────────────────────────────────────────────
//
// Phase K of chat-fix-and-dm-system plan (1 May 2026). Stefan asked for
// chat "on left? Not sure" — so rather than a full app-wide sidebar
// redesign that would risk regressions across every authenticated page,
// this is a chat icon that lives next to the notification bell. Clicking
// it opens a popover showing recent 1:1 + group conversations with quick
// links to the full /messages page. Same data model the inbox uses, so
// no divergence between surfaces.

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Loader2 } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';

interface ConversationSummary {
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string | null;
  otherAvatarUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageFromMe: boolean;
  unreadCount: number;
}

interface GroupSummary {
  id: string;
  name: string;
  type: 'custom' | 'pod';
  lastMessageAt: string | null;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return d.toLocaleDateString();
}

export default function ChatQuickAccess() {
  const navigate = useNavigate();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const { data: conversations, refetch: refetchConv } = useQuery({
    queryKey: ['dm-conversations'],
    queryFn: () => api.get('/dm/conversations').then(r => r.data.data as ConversationSummary[]),
    refetchOnWindowFocus: true,
    meta: { entities: currentUserId ? [E.userDms(currentUserId)] : [] },
  });

  const { data: groups, refetch: refetchGroups } = useQuery({
    queryKey: ['dm-groups'],
    queryFn: () => api.get('/groups').then(r => r.data.data as GroupSummary[]).catch(() => [] as GroupSummary[]),
    refetchOnWindowFocus: true,
    meta: { entities: currentUserId ? [E.userDms(currentUserId)] : [] },
  });

  // Real-time refresh on incoming socket events.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const refresh = () => {
      refetchConv();
      refetchGroups();
    };
    socket.on('dm:message', refresh);
    socket.on('dm:conversation_updated', refresh);
    return () => {
      socket.off('dm:message', refresh);
      socket.off('dm:conversation_updated', refresh);
    };
  }, [refetchConv, refetchGroups]);

  const totalUnread = (conversations || []).reduce((sum, c) => sum + (c.unreadCount || 0), 0);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328)),
      });
    }
    setOpen(!open);
  };

  const goToConversation = (id: string) => {
    setOpen(false);
    navigate(`/messages/${id}`);
  };

  const goToInbox = () => {
    setOpen(false);
    navigate('/messages');
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
        title="Messages"
        aria-label="Messages"
      >
        <MessageSquare className="h-5 w-5 text-gray-600" />
        {totalUnread > 0 && (
          <span className="absolute top-0.5 right-0.5 bg-rsn-red text-white text-[10px] font-bold rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>

      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-80 max-h-[480px] bg-white rounded-xl border border-gray-200 shadow-xl overflow-hidden flex flex-col"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#1a1a2e]">Messages</h3>
              <button
                onClick={goToInbox}
                className="text-xs text-rsn-red hover:underline"
              >
                Open inbox
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {!conversations && !groups ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                </div>
              ) : (conversations?.length || 0) === 0 && (groups?.length || 0) === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-gray-400">
                  No conversations yet.
                </div>
              ) : (
                <>
                  {(conversations || []).slice(0, 8).map(c => (
                    <button
                      key={c.conversationId}
                      onClick={() => goToConversation(c.conversationId)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 transition-colors text-left"
                    >
                      <Avatar src={c.otherAvatarUrl || undefined} name={c.otherDisplayName || 'User'} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between">
                          <p className="text-xs font-medium text-[#1a1a2e] truncate">{c.otherDisplayName || 'User'}</p>
                          {c.lastMessageAt && <span className="text-[10px] text-gray-400 ml-2 flex-shrink-0">{formatRelative(c.lastMessageAt)}</span>}
                        </div>
                        <p className={`text-[11px] truncate ${c.unreadCount > 0 && !c.lastMessageFromMe ? 'font-semibold text-[#1a1a2e]' : 'text-gray-500'}`}>
                          {c.lastMessageFromMe ? 'You: ' : ''}{c.lastMessage || 'No messages yet'}
                        </p>
                      </div>
                      {c.unreadCount > 0 && !c.lastMessageFromMe && (
                        <span className="bg-rsn-red text-white text-[9px] font-bold rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1 flex-shrink-0">
                          {c.unreadCount}
                        </span>
                      )}
                    </button>
                  ))}
                  {(groups || []).slice(0, 5).map(g => (
                    <button
                      key={g.id}
                      onClick={goToInbox}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 transition-colors text-left"
                    >
                      <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <MessageSquare className="h-4 w-4 text-gray-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-[#1a1a2e] truncate">{g.name}</p>
                        <p className="text-[10px] text-gray-400">{g.type === 'pod' ? 'Pod chat' : 'Group'}{g.lastMessageAt ? ` · ${formatRelative(g.lastMessageAt)}` : ''}</p>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
