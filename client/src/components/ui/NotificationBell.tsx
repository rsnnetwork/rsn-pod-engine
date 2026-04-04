import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, CheckCircle, X, Loader2 } from 'lucide-react';
// Navigation uses window.location.href because portal renders outside Router context
import { useQueryClient } from '@tanstack/react-query';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  isRead: boolean;
  createdAt: string;
  inviteStatus?: string | null; // 'pending' | 'accepted' | 'revoked' | 'expired'
  podId?: string | null;
  sessionId?: string | null;
}

const INVITE_TYPES = ['pod_invite', 'event_invite'];

/** Extract invite code from `/invite/{code}` link */
function extractInviteCode(link?: string): string | null {
  if (!link) return null;
  const match = link.match(/^\/invite\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

/** Get the in-app destination for a notification */
function getDestination(n: Notification): string | null {
  if (n.sessionId) return `/sessions/${n.sessionId}`;
  if (n.podId) return `/pods/${n.podId}`;
  // For non-invite notifications, use the link directly
  if (n.link && !n.link.startsWith('/invite/')) return n.link;
  // For invite notifications, navigate to the invite page so user can see details
  if (n.link && n.link.startsWith('/invite/')) return n.link;
  return null;
}

export default function NotificationBell() {
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // navigate removed — using window.location.href for portal compatibility
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

  // Fetch on mount + poll every 30s for pages without socket
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  // Listen for real-time notifications via socket
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (data: Notification) => {
      setNotifications(prev => [data, ...prev].slice(0, 20));
      setUnreadCount(prev => prev + 1);
    };
    socket.on('notification:new', handler);
    return () => { socket.off('notification:new', handler); };
  }, []);

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
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, inviteStatus: 'accepted', isRead: true } : x));
      invalidateInviteCaches();
      setOpen(false);
      // Navigate to the pod/session — check profile completeness first
      const data = res.data?.data;
      const dest = data?.sessionId ? `/sessions/${data.sessionId}` : data?.podId ? `/pods/${data.podId}` : null;
      if (dest) {
        const profileIncomplete = !user?.displayName || !user?.jobTitle;
        setOpen(false);
        setTimeout(() => {
          window.location.href = profileIncomplete ? `/onboarding?redirect=${encodeURIComponent(dest)}` : dest;
        }, 50);
      }
    } catch (err: any) {
      const errCode = err?.response?.data?.error?.code;
      // Already registered/member = treat as success, navigate to event
      if (errCode === 'SESSION_ALREADY_REGISTERED' || errCode === 'POD_MEMBER_EXISTS') {
        addToast('You\'re already in! Navigating...', 'success');
        if (!n.isRead) markRead(n.id);
        setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, inviteStatus: 'accepted', isRead: true } : x));
        invalidateInviteCaches();
        setOpen(false);
        const dest = getDestination(n);
        if (dest) setTimeout(() => { window.location.href = dest; }, 50);
        return;
      }
      const msg = errCode === 'INVITE_REVOKED' ? 'This invite has been revoked'
        : errCode === 'INVITE_EXPIRED' ? 'This invite has expired'
        : errCode === 'INVITE_ALREADY_USED' ? 'This invite has been fully used'
        : err?.response?.data?.error?.message || 'Failed to accept invite';
      addToast(msg, 'error');
      setNotifications(prev => prev.map(x => x.id === n.id ? {
        ...x,
        inviteStatus: errCode === 'INVITE_REVOKED' ? 'revoked' : errCode === 'INVITE_EXPIRED' ? 'expired' : x.inviteStatus,
      } : x));
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
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, inviteStatus: 'revoked', isRead: true } : x));
      invalidateInviteCaches();
    } catch {
      addToast('Failed to decline invite', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * Click handler for notification title. Navigates based on type + status:
   * - Invite (accepted) → go to the pod/session
   * - Invite (pending) → do nothing (use Accept/Decline buttons)
   * - Invite (declined/expired) → toast, no navigation
   * - Other notification types → navigate to link destination
   */
  const handleClick = (n: Notification) => {
    if (!n.isRead) markRead(n.id);

    if (n.inviteStatus === 'revoked') {
      addToast('This invite was declined', 'info');
      return;
    }
    if (n.inviteStatus === 'expired') {
      addToast('This invite has expired', 'info');
    }

    // Navigate to destination — use window.location because portal renders outside Router
    const dest = getDestination(n);
    if (dest) {
      setOpen(false);
      // Small delay to let panel close animation complete before navigation
      setTimeout(() => { window.location.href = dest; }, 50);
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

  /** Only show action buttons for pending invites */
  const canActOnInvite = (n: Notification) =>
    INVITE_TYPES.includes(n.type) && extractInviteCode(n.link) && n.inviteStatus === 'pending';

  /** Status label for resolved invites */
  const getInviteStatusLabel = (n: Notification) => {
    if (!INVITE_TYPES.includes(n.type) || !n.inviteStatus || n.inviteStatus === 'pending') return null;
    if (n.inviteStatus === 'accepted') return { text: 'Accepted', color: 'text-emerald-500' };
    if (n.inviteStatus === 'revoked') return { text: 'Declined', color: 'text-gray-400' };
    if (n.inviteStatus === 'expired') return { text: 'Expired', color: 'text-amber-400' };
    return null;
  };

  return (
    <div ref={ref} className="relative z-50">
      <button ref={btnRef} onClick={handleOpen} className="relative p-2 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors">
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-rsn-red text-white text-[10px] font-bold rounded-full px-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)}>
          {/* Backdrop overlay for mobile */}
          <div className="absolute inset-0 bg-black/20 sm:bg-transparent" />
          {/* Notification panel — stopPropagation prevents backdrop close on panel click */}
          <div className="absolute z-[9999] sm:rounded-xl rounded-t-2xl bg-white shadow-xl border border-gray-200 overflow-hidden
            inset-x-0 bottom-0 sm:inset-auto sm:w-80 max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
            style={dropPos && typeof window !== 'undefined' && window.innerWidth >= 640 ? {
              top: dropPos.top,
              left: dropPos.left,
            } : undefined}>
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
              const isClickable = true; // All notifications are clickable — navigate to destination

              return (
                <div
                  key={n.id}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors ${!n.isRead ? 'bg-blue-50/40' : ''}`}
                >
                  {/* Clickable title area */}
                  <button
                    onClick={() => handleClick(n)}
                    className={`w-full text-left ${isClickable ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.isRead && <div className="mt-1.5 w-2 h-2 rounded-full bg-rsn-red shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={`text-sm leading-snug ${!n.isRead ? 'font-medium text-gray-800' : 'text-gray-600'}`}>{n.title}</p>
                          {statusLabel && (
                            <span className={`text-[10px] font-medium shrink-0 ${statusLabel.color}`}>{statusLabel.text}</span>
                          )}
                        </div>
                        {n.body && <p className="text-xs text-gray-400 mt-0.5">{n.body}</p>}
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
                </div>
              );
            })}
          </div>
        </div>
        </div>,
        document.body
      )}
    </div>
  );
}
