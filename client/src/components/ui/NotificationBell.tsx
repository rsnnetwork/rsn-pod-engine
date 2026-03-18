import { useState, useRef, useEffect } from 'react';
import { Bell, Check, CheckCircle, X, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  isRead: boolean;
  createdAt: string;
  inviteStatus?: string | null; // 'pending' | 'accepted' | 'revoked' | 'expired' — from server join
}

const INVITE_TYPES = ['pod_invite', 'event_invite'];

/** Extract invite code from `/invite/{code}` link */
function extractInviteCode(link?: string): string | null {
  if (!link) return null;
  const match = link.match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const qc = useQueryClient();

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchNotifications = async () => {
    setLoading(true);
    try {
      const res = await api.get('/notifications');
      setNotifications(res.data.data.notifications);
      setUnreadCount(res.data.data.unreadCount);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchNotifications(); }, []);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropPos({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328)),
      });
    }
    setOpen(!open);
    if (!open) fetchNotifications();
  };

  const markRead = async (id: string) => {
    await api.post(`/notifications/${id}/read`).catch(() => {});
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    await api.post('/notifications/read-all').catch(() => {});
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    setUnreadCount(0);
  };

  /** Invalidate all caches that display invite/membership data */
  const invalidateInviteCaches = () => {
    qc.invalidateQueries({ queryKey: ['received-invites'] });
    qc.invalidateQueries({ queryKey: ['my-pods'] });
    qc.invalidateQueries({ queryKey: ['my-sessions'] });
  };

  const handleAcceptInvite = async (n: Notification) => {
    const code = extractInviteCode(n.link);
    if (!code) return;
    setActionLoading(n.id);
    try {
      const res = await api.post(`/invites/${code}/accept`);
      addToast('Invite accepted!', 'success');
      if (!n.isRead) markRead(n.id);
      // Update notification status locally so buttons disappear
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, inviteStatus: 'accepted', isRead: true } : x));
      invalidateInviteCaches();
      setOpen(false);
      // Navigate to destination
      const data = res.data?.data;
      if (data?.sessionId) navigate(`/sessions/${data.sessionId}`);
      else if (data?.podId) navigate(`/pods/${data.podId}`);
      else navigate('/sessions');
    } catch (err: any) {
      const code_ = err?.response?.data?.error?.code;
      const msg = code_ === 'INVITE_REVOKED' ? 'This invite has been revoked'
        : code_ === 'INVITE_EXPIRED' ? 'This invite has expired'
        : code_ === 'INVITE_ALREADY_USED' ? 'This invite has been fully used'
        : code_ === 'AUTH_FORBIDDEN' ? 'This invite was sent to a different email'
        : err?.response?.data?.error?.message || 'Failed to accept invite';
      addToast(msg, 'error');
      // Update status so buttons reflect reality
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, inviteStatus: code_ === 'INVITE_REVOKED' ? 'revoked' : code_ === 'INVITE_EXPIRED' ? 'expired' : x.inviteStatus } : x));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeclineInvite = async (n: Notification) => {
    const code = extractInviteCode(n.link);
    if (!code) return;
    setActionLoading(n.id);
    try {
      await api.post(`/invites/${code}/decline`);
      addToast('Invite declined', 'info');
      if (!n.isRead) markRead(n.id);
      // Update notification status locally
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, inviteStatus: 'revoked', isRead: true } : x));
      invalidateInviteCaches();
    } catch {
      addToast('Failed to decline invite', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleClick = (n: Notification) => {
    if (!n.isRead) markRead(n.id);
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    }
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  /** Only show action buttons for invite notifications where the invite is still pending */
  const canActOnInvite = (n: Notification) =>
    INVITE_TYPES.includes(n.type) && extractInviteCode(n.link) && n.inviteStatus === 'pending';

  /** Show a status label for non-pending invite notifications */
  const getInviteStatusLabel = (n: Notification) => {
    if (!INVITE_TYPES.includes(n.type) || !n.inviteStatus || n.inviteStatus === 'pending') return null;
    if (n.inviteStatus === 'accepted') return { text: 'Accepted', color: 'text-emerald-500' };
    if (n.inviteStatus === 'revoked') return { text: 'Declined', color: 'text-gray-400' };
    if (n.inviteStatus === 'expired') return { text: 'Expired', color: 'text-amber-400' };
    return null;
  };

  return (
    <div ref={ref} className="relative">
      <button ref={btnRef} onClick={handleOpen} className="relative p-2 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors">
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-rsn-red text-white text-[10px] font-bold rounded-full px-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed w-80 bg-white rounded-xl shadow-xl border border-gray-200 z-[9999] overflow-hidden" style={dropPos ? { top: dropPos.top, left: dropPos.left } : undefined}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700">Notifications</h3>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-rsn-red hover:underline flex items-center gap-1">
                <Check className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {loading && notifications.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-6">Loading...</p>
            )}
            {!loading && notifications.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-6">No notifications yet</p>
            )}
            {notifications.map(n => {
              const showActions = canActOnInvite(n);
              const statusLabel = getInviteStatusLabel(n);
              const isActing = actionLoading === n.id;

              return (
                <div
                  key={n.id}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors ${!n.isRead ? 'bg-blue-50/40' : ''}`}
                >
                  {/* Clickable title area */}
                  <button onClick={() => handleClick(n)} className="w-full text-left hover:opacity-80">
                    <div className="flex items-start gap-2">
                      {!n.isRead && <div className="mt-1.5 w-2 h-2 rounded-full bg-rsn-red shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm truncate ${!n.isRead ? 'font-medium text-gray-800' : 'text-gray-600'}`}>{n.title}</p>
                        {n.body && <p className="text-xs text-gray-400 truncate mt-0.5">{n.body}</p>}
                        <p className="text-[10px] text-gray-300 mt-1">{formatTime(n.createdAt)}</p>
                      </div>
                    </div>
                  </button>

                  {/* Inline Accept / Decline for PENDING invite notifications only */}
                  {showActions && (
                    <div className="flex items-center gap-2 mt-2 ml-4">
                      <button
                        onClick={() => handleAcceptInvite(n)}
                        disabled={isActing}
                        className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 transition-colors"
                      >
                        {isActing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                        Accept
                      </button>
                      <button
                        onClick={() => handleDeclineInvite(n)}
                        disabled={isActing}
                        className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                      >
                        <X className="h-3 w-3" />
                        Decline
                      </button>
                    </div>
                  )}

                  {/* Status label for already-acted invites */}
                  {statusLabel && (
                    <div className="mt-1.5 ml-4">
                      <span className={`text-xs font-medium ${statusLabel.color}`}>{statusLabel.text}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
