// Messages page — Phase E of chat-fix-and-dm-system plan (1 May 2026).
//
// Two-pane layout: conversation list (left) + active thread (right).
// On mobile: single-pane, list collapses when a conversation is open.
//
// Real-time updates: subscribes to dm:message, dm:read_receipt,
// dm:conversation_updated. Updates React Query cache so the inbox sort
// + thread view update without polling.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Send, Smile, Trash2, MessageSquare } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader, Spinner } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';

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

interface DmMessage {
  id: string;
  conversationId: string;
  fromUserId: string;
  content: string;
  readAt: string | null;
  createdAt: string;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

// Phase A polish — date separators ("Today" / "Yesterday" / "Mon May 1") between day boundaries.
function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayHeaderLabel(d: Date): string {
  const now = new Date();
  if (sameLocalDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return 'Yesterday';
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (daysAgo < 7) return d.toLocaleDateString([], { weekday: 'long' });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeOnly(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Phase A polish — group consecutive messages from the same sender within 60s
// so we only show name/avatar/timestamp once per cluster (iMessage / WhatsApp pattern).
const CLUSTER_GAP_MS = 60_000;

// Phase B polish — curated emoji set for the composer picker.
// Same 20 the in-event ChatPanel uses, kept duplicated rather than abstracted
// because each chat surface might tune its own list later (no premature DRY).
const EMOJI_PICKER_LIST = [
  '😀','😂','😍','🥳','🤔','👍','👏','❤️','🔥','🎉',
  '💯','🙌','😮','🤩','😎','👋','✅','💪','🙏','⭐',
];

interface MessageCluster {
  senderId: string;
  messages: DmMessage[];
}

function clusterMessages(messages: DmMessage[]): MessageCluster[] {
  const clusters: MessageCluster[] = [];
  for (const msg of messages) {
    const last = clusters[clusters.length - 1];
    const lastMsg = last?.messages[last.messages.length - 1];
    const gap = lastMsg ? new Date(msg.createdAt).getTime() - new Date(lastMsg.createdAt).getTime() : Infinity;
    if (last && last.senderId === msg.fromUserId && gap < CLUSTER_GAP_MS) {
      last.messages.push(msg);
    } else {
      clusters.push({ senderId: msg.fromUserId, messages: [msg] });
    }
  }
  return clusters;
}

export default function MessagesPage() {
  const { conversationId: activeId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const myUserId = user?.id;
  const [draft, setDraft] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Inbox: list of conversations sorted by recent activity.
  const { data: inboxData } = useQuery({
    queryKey: ['dm-conversations'],
    queryFn: () => api.get('/dm/conversations').then(r => r.data.data as ConversationSummary[]),
    refetchOnWindowFocus: true,
  });

  // Thread: messages in the active conversation.
  const { data: messagesData } = useQuery({
    queryKey: ['dm-messages', activeId],
    queryFn: () => api.get(`/dm/conversations/${activeId}/messages`).then(r => r.data.data as DmMessage[]),
    enabled: !!activeId,
  });

  // Mark-as-read: fire on opening a conversation.
  useEffect(() => {
    if (!activeId) return;
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('dm:read', { conversationId: activeId });
    } else {
      api.post(`/dm/conversations/${activeId}/read`).catch(err => console.warn('mark-read failed', err));
    }
  }, [activeId]);

  // Real-time subscriptions: refresh inbox + active thread on incoming events.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onMessage = (msg: DmMessage) => {
      // If it's for the active thread, append + refetch
      if (msg.conversationId === activeId) {
        qc.invalidateQueries({ queryKey: ['dm-messages', activeId] });
      }
      // Always refresh inbox sort + unread badge
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      qc.invalidateQueries({ queryKey: ['dm-unread-count'] });
    };
    const onConversationUpdated = () => {
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
    };
    const onReadReceipt = (data: { conversationId: string }) => {
      if (data.conversationId === activeId) {
        qc.invalidateQueries({ queryKey: ['dm-messages', activeId] });
      }
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      qc.invalidateQueries({ queryKey: ['dm-unread-count'] });
    };

    socket.on('dm:message', onMessage);
    socket.on('dm:conversation_updated', onConversationUpdated);
    socket.on('dm:read_receipt', onReadReceipt);
    return () => {
      socket.off('dm:message', onMessage);
      socket.off('dm:conversation_updated', onConversationUpdated);
      socket.off('dm:read_receipt', onReadReceipt);
    };
  }, [activeId, qc]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesData]);

  const activeConv = inboxData?.find(c => c.conversationId === activeId);

  const sendMutation = useMutation({
    mutationFn: (content: string) => {
      if (!activeConv) throw new Error('No active conversation');
      return api.post('/dm/messages', { toUserId: activeConv.otherUserId, content });
    },
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['dm-messages', activeId] });
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Failed to send message', 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/dm/conversations/${id}`),
    onSuccess: () => {
      addToast('Conversation deleted', 'info');
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      navigate('/messages');
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Failed to delete', 'error');
    },
  });

  if (!myUserId) return <PageLoader />;

  return (
    <div className="flex flex-col md:flex-row gap-4 h-[calc(100vh-100px)]">
      {/* Conversation list (left, hidden on mobile when a thread is open) */}
      <div className={`md:w-80 md:flex-shrink-0 bg-white rounded-xl border border-gray-200 overflow-hidden ${activeId ? 'hidden md:flex' : 'flex'} flex-col`}>
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-[#1a1a2e]">Messages</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {inboxData === undefined ? (
            <div className="flex items-center justify-center py-12"><Spinner /></div>
          ) : inboxData.length === 0 ? (
            <div className="text-center py-12 px-4 text-sm text-gray-500">
              No conversations yet. Once you meet someone in an event, you can DM them from their profile.
            </div>
          ) : (
            inboxData.map(c => (
              <Link
                key={c.conversationId}
                to={`/messages/${c.conversationId}`}
                className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition-colors ${activeId === c.conversationId ? 'bg-rsn-red/5' : ''}`}
              >
                <Avatar src={c.otherAvatarUrl || undefined} name={c.otherDisplayName || 'User'} size="md" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-medium text-[#1a1a2e] truncate">{c.otherDisplayName || 'User'}</p>
                    {c.lastMessageAt && <span className="text-[10px] text-gray-400 flex-shrink-0 ml-2">{formatRelative(c.lastMessageAt)}</span>}
                  </div>
                  <p className={`text-xs truncate ${c.unreadCount > 0 && !c.lastMessageFromMe ? 'font-semibold text-[#1a1a2e]' : 'text-gray-500'}`}>
                    {c.lastMessageFromMe ? 'You: ' : ''}{c.lastMessage || <em className="text-gray-300">No messages yet</em>}
                  </p>
                </div>
                {c.unreadCount > 0 && !c.lastMessageFromMe && (
                  <span className="bg-rsn-red text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                    {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  </span>
                )}
              </Link>
            ))
          )}
        </div>
      </div>

      {/* Thread view (right) */}
      <div className={`flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden ${activeId ? 'flex' : 'hidden md:flex'} flex-col`}>
        {!activeId || !activeConv ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500 px-6 text-center">
            Select a conversation to start chatting.
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
              <button
                onClick={() => navigate('/messages')}
                className="md:hidden p-1 rounded-lg hover:bg-gray-100"
                aria-label="Back to inbox"
              >
                <ArrowLeft className="h-4 w-4 text-gray-500" />
              </button>
              <Avatar src={activeConv.otherAvatarUrl || undefined} name={activeConv.otherDisplayName || 'User'} size="sm" />
              <Link to={`/profile/${activeConv.otherUserId}`} className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#1a1a2e] truncate hover:underline">{activeConv.otherDisplayName || 'User'}</p>
              </Link>
              <button
                onClick={() => {
                  if (confirm('Delete this conversation from your view? The other person\'s view is unaffected.')) {
                    deleteMutation.mutate(activeConv.conversationId);
                  }
                }}
                className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"
                title="Delete conversation"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {/* Messages — clustered by sender + day */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {messagesData === undefined ? (
                <div className="flex items-center justify-center py-8"><Spinner /></div>
              ) : messagesData.length === 0 ? (
                <div className="text-center py-8 text-sm text-gray-500">No messages yet — say hi!</div>
              ) : (
                (() => {
                  // Server returns newest-first; we render oldest-first.
                  const oldest = [...messagesData].reverse();
                  const clusters = clusterMessages(oldest);
                  const elements: ReactNode[] = [];
                  let prevClusterDate: Date | null = null;

                  clusters.forEach((cluster, ci) => {
                    const firstDate = new Date(cluster.messages[0].createdAt);
                    const lastMsg = cluster.messages[cluster.messages.length - 1];
                    const lastDate = new Date(lastMsg.createdAt);

                    // Day separator when the cluster crosses a day boundary
                    if (!prevClusterDate || !sameLocalDay(firstDate, prevClusterDate)) {
                      elements.push(
                        <div key={`day-${cluster.messages[0].id}`} className="flex items-center justify-center py-3">
                          <span className="text-[11px] font-medium text-gray-500 bg-gray-100 px-2.5 py-0.5 rounded-full">
                            {dayHeaderLabel(firstDate)}
                          </span>
                        </div>,
                      );
                    }

                    const fromMe = cluster.senderId === myUserId;

                    elements.push(
                      <div
                        key={cluster.messages[0].id}
                        className={`flex items-end gap-2 ${fromMe ? 'justify-end' : 'justify-start'} ${ci > 0 ? 'mt-3' : ''}`}
                      >
                        {!fromMe && (
                          <div className="flex-shrink-0">
                            <Avatar
                              src={activeConv.otherAvatarUrl || undefined}
                              name={activeConv.otherDisplayName || 'User'}
                              size="sm"
                            />
                          </div>
                        )}
                        <div className={`flex flex-col max-w-[75%] sm:max-w-[60%] ${fromMe ? 'items-end' : 'items-start'}`}>
                          {cluster.messages.map((m, idx) => {
                            const isLast = idx === cluster.messages.length - 1;
                            return (
                              <div
                                key={m.id}
                                data-message-id={m.id}
                                className={`px-3.5 py-2 text-sm break-words whitespace-pre-wrap ${
                                  fromMe
                                    ? `bg-rsn-red text-white rounded-2xl ${isLast ? 'rounded-br-sm' : ''}`
                                    : `bg-gray-100 text-[#1a1a2e] rounded-2xl ${isLast ? 'rounded-bl-sm' : ''}`
                                } ${idx > 0 ? 'mt-0.5' : ''}`}
                              >
                                {m.content}
                              </div>
                            );
                          })}
                          <p className="text-[10px] text-gray-400 mt-1 px-1">
                            {timeOnly(lastDate)}
                            {fromMe && lastMsg.readAt ? ' · seen' : ''}
                          </p>
                        </div>
                      </div>,
                    );

                    prevClusterDate = lastDate;
                  });

                  return elements;
                })()
              )}
              <div ref={threadEndRef} />
            </div>

            {/* Composer — Phase A polish: 16px input on mobile (kills iOS auto-zoom),
                safe-area padding so iPhone home indicator doesn't cover it,
                44pt send button on mobile (Apple HIG touch target).
                Phase B polish: emoji picker behind the smile icon. */}
            <div
              className="relative px-3 py-2 border-t border-gray-200"
              style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)' }}
            >
              {showEmoji && (
                <div
                  className="absolute bottom-full left-3 right-3 mb-2 bg-white border border-gray-200 rounded-xl shadow-lg p-2 grid grid-cols-6 sm:grid-cols-10 gap-1 z-10"
                  role="dialog"
                  aria-label="Emoji picker"
                >
                  {EMOJI_PICKER_LIST.map(e => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => {
                        setDraft(prev => prev + e);
                        setShowEmoji(false);
                        textareaRef.current?.focus();
                      }}
                      className="text-xl sm:text-lg hover:bg-gray-100 active:scale-95 rounded p-1.5 transition-transform"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowEmoji(s => !s)}
                  className="w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0"
                  aria-label="Add emoji"
                  title="Add emoji"
                >
                  <Smile className="h-5 w-5" />
                </button>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={() => {
                    // Phase A polish — when keyboard opens on mobile the thread
                    // can scroll out from under it; pin to the latest message.
                    setTimeout(() => threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 250);
                    setShowEmoji(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (draft.trim() && !sendMutation.isPending) sendMutation.mutate(draft.trim());
                    }
                  }}
                  rows={1}
                  placeholder="Type a message..."
                  className="flex-1 resize-none px-3 py-2 text-base sm:text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-rsn-red max-h-32"
                  maxLength={4000}
                />
                <Button
                  size="sm"
                  onClick={() => sendMutation.mutate(draft.trim())}
                  disabled={!draft.trim() || sendMutation.isPending}
                  isLoading={sendMutation.isPending}
                  className="!w-11 !h-11 sm:!w-9 sm:!h-9 !p-0 flex-shrink-0"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
