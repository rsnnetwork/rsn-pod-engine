import { useState, useEffect } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calendar, Users, Play, Clock, UserPlus, UserMinus, Settings, CheckCircle, Pencil, Trash2, Mail, Copy, Check, AlertTriangle, CopyPlus, Search, Send } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { formatDateTime, LOCAL_TIME_LABEL } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { sessionStatusLabel, sessionStatusColor, sessionStatusPhase } from './statusConfig';

function getInviteErrorMessage(err: any): string {
  const code = err?.response?.data?.error?.code;
  const message = err?.response?.data?.error?.message;
  switch (code) {
    case 'DUPLICATE_INVITE': return 'This person already has a pending invite';
    case 'SELF_INVITE': return 'You cannot send an invite to yourself';
    case 'ALREADY_REGISTERED': return 'This person already has an account on the platform';
    case 'POD_MEMBER_EXISTS': return 'This person is already a member of this pod';
    case 'SESSION_ALREADY_REGISTERED': return 'This person is already a participant of this event';
    case 'POD_ARCHIVED': return 'Cannot send invites to an archived pod';
    case 'AUTH_FORBIDDEN': return message || 'You do not have permission to send this invite';
    default: return message || 'Failed to send invite. Please try again';
  }
}

export default function SessionDetailPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editScheduledAt, setEditScheduledAt] = useState('');
  const [editNumberOfRounds, setEditNumberOfRounds] = useState(5);
  const [editRoundDurationMinutes, setEditRoundDurationMinutes] = useState(8);
  const [editTimerVisibility, setEditTimerVisibility] = useState('always_visible');
  const [editMaxParticipants, setEditMaxParticipants] = useState(500);
  const [editMatchingTemplateId, setEditMatchingTemplateId] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const debouncedUserSearch = useDebouncedValue(userSearch, 300);
  const [selectedUsers, setSelectedUsers] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [showPendingInvites, setShowPendingInvites] = useState(false);
  const [invitingMember, setInvitingMember] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Close overflow menu on Escape only — click-outside handled by backdrop overlay
  // (more reliable than document mousedown listener which raced with menu items)
  useEffect(() => {
    if (!overflowOpen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverflowOpen(false); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [overflowOpen]);

  const { data: session, isLoading, error: sessionError } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    retry: (failureCount, err: any) => {
      // Don't retry 403s — access is intentionally denied
      if (err?.response?.status === 403) return false;
      return failureCount < 3;
    },
  });

  const { data: pod } = useQuery({
    queryKey: ['pod', session?.podId],
    queryFn: () => api.get(`/pods/${session.podId}`).then(r => r.data.data),
    enabled: !!session?.podId,
  });

  const { data: participants } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then(r => r.data.data ?? []),
    enabled: !!sessionId,
  });

  const { data: templates } = useQuery({
    queryKey: ['matching-templates'],
    queryFn: () => api.get('/matching-templates').then(r => r.data.data ?? []),
  });

  const isHost = session?.hostUserId === user?.id;
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const { data: participantCounts } = useQuery({
    queryKey: ['session-participant-counts', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participant-counts`).then(r => r.data.data),
    enabled: !!sessionId && (isHost || isAdmin),
  });
  const { data: pendingInvites } = useQuery({
    queryKey: ['session-pending-invites', sessionId],
    queryFn: () => api.get(`/invites/session/${sessionId}?status=pending`).then(r => r.data.data ?? []),
    enabled: !!sessionId && (isHost || isAdmin),
  });

  const { data: podMembers, refetch: refetchPodMembers } = useQuery({
    queryKey: ['pod-members-for-invite', session?.podId, sessionId],
    queryFn: () => api.get(`/pods/${session?.podId}/members/for-invite?sessionId=${sessionId}`).then(r => r.data.data),
    enabled: !!session?.podId && !!sessionId && isHost,
  });

  const invitePodMember = async (userId: string, email: string) => {
    setInvitingMember(userId);
    try {
      await api.post('/invites', {
        type: 'session',
        sessionId,
        inviteeEmail: email,
        maxUses: 1,
      });
      addToast('Invite sent!', 'success');
      refetchPodMembers();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Failed to invite', 'error');
    } finally {
      setInvitingMember(null);
    }
  };

  const remindMutation = useMutation({
    mutationFn: (inviteId: string) => api.post(`/invites/${inviteId}/remind`),
    onSuccess: () => addToast('Reminder sent!', 'success'),
    onError: () => addToast('Failed to send reminder', 'error'),
  });

  const remindAllMutation = useMutation({
    mutationFn: () => api.post(`/invites/remind-all/${sessionId}`),
    onSuccess: (res) => {
      const { reminded, total } = res.data.data;
      addToast(`Reminders sent to ${reminded}/${total} pending invites`, 'success');
    },
    onError: () => addToast('Failed to send bulk reminders', 'error'),
  });

  const isRegistered = (participants || []).some((p: any) => p.userId === user?.id && p.status !== 'removed');
  const isMember = !!pod?.memberRole || isAdmin;
  const isRestrictedPod = pod?.visibility === 'invite_only' || pod?.visibility === 'private';
  const canRegister = isMember || !isRestrictedPod;
  const [autoRegistering, setAutoRegistering] = useState(false);

  // Auto-register: if user landed here and isn't registered, register them immediately.
  // Shows loading state so "Register" button never flashes.
  useEffect(() => {
    if (session && user && participants && !isRegistered && !autoRegistering && sessionId) {
      setAutoRegistering(true);
      api.post(`/sessions/${sessionId}/register`).then(() => {
        qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      }).catch(() => { /* not allowed or already registered */ })
        .finally(() => setAutoRegistering(false));
    }
  }, [session?.id, user?.id, isRegistered]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMutation = useMutation({
    mutationFn: (body: { title?: string; description?: string; scheduledAt?: string; config?: Record<string, any> }) => api.put(`/sessions/${sessionId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Event updated', 'success');
      setEditOpen(false);
    },
    onError: () => addToast('Failed to update event', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}`),
    onSuccess: () => {
      addToast('Event deleted', 'success');
      navigate('/sessions');
    },
    onError: () => addToast('Failed to delete event', 'error'),
  });

  const openEdit = () => {
    setEditTitle(session?.title || '');
    setEditDescription(session?.description || '');
    setEditScheduledAt(session?.scheduledAt ? new Date(session.scheduledAt).toISOString().slice(0, 16) : '');
    setEditNumberOfRounds(session?.config?.numberOfRounds ?? 5);
    setEditRoundDurationMinutes(Math.round((session?.config?.roundDurationSeconds ?? 480) / 60));
    setEditTimerVisibility(session?.config?.timerVisibility ?? 'always_visible');
    setEditMaxParticipants(session?.config?.maxParticipants ?? 500);
    setEditMatchingTemplateId(session?.config?.matchingTemplateId ?? '');
    setEditOpen(true);
  };

  const registerMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Registered for event!', 'success');
    },
    onError: (err: any) => {
      const errCode = err?.response?.data?.error?.code;
      if (errCode === 'SESSION_ALREADY_REGISTERED') {
        addToast('You\'re already registered for this event!', 'info');
        qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      } else {
        const msg = err?.response?.data?.error?.message || 'Failed to register';
        addToast(msg, 'error');
      }
    },
  });

  const createSessionInviteMutation = useMutation({
    mutationFn: (body: { inviteeEmail?: string }) =>
      api.post('/invites', { type: 'session', sessionId, maxUses: body.inviteeEmail ? 1 : 10, expiresInHours: 168, ...body }),
    onSuccess: (res: any, variables) => {
      const code = res.data?.data?.code;
      if (code) setInviteLink(`${window.location.origin}/invite/${code}`);
      if (variables.inviteeEmail) {
        addToast(`Invite sent to ${variables.inviteeEmail}`, 'success');
        setInviteEmail('');
      } else {
        addToast('Invite link generated!', 'success');
      }
    },
    onError: (err: any) => addToast(getInviteErrorMessage(err), 'error'),
  });

  const duplicateMutation = useMutation({
    mutationFn: () => api.post('/sessions', {
      podId: session?.podId,
      title: `${session?.title || 'Event'} (copy)`,
      description: session?.description || '',
      scheduledAt: null,
      config: session?.config,
    }),
    onSuccess: (res: any) => {
      const newId = res.data?.data?.id;
      addToast('Event duplicated! Edit the new event to set a date.', 'success');
      if (newId) navigate(`/sessions/${newId}`);
    },
    onError: () => addToast('Failed to duplicate event', 'error'),
  });

  // Search connected users (people the host has met in a previous event) — debounced to avoid API spam
  const { data: searchResults } = useQuery({
    queryKey: ['connected-user-search', debouncedUserSearch],
    queryFn: () => api.get(`/users/connected?q=${encodeURIComponent(debouncedUserSearch)}`).then(r => r.data.data ?? []),
    enabled: debouncedUserSearch.length >= 1 && isHost,
  });

  const bulkInviteMutation = useMutation({
    mutationFn: async (emails: string[]) => {
      const results: { email: string; ok: boolean; msg?: string }[] = [];
      for (const email of emails) {
        try {
          await api.post('/invites', { type: 'session', sessionId, maxUses: 1, inviteeEmail: email });
          results.push({ email, ok: true });
        } catch (err: any) {
          const msg = err?.response?.data?.error?.message || 'Failed to send invite';
          results.push({ email, ok: false, msg });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      const succeeded = results.filter(r => r.ok);
      const failed = results.filter(r => !r.ok);
      if (succeeded.length > 0) addToast(`${succeeded.length} invite(s) sent!`, 'success');
      failed.forEach(r => addToast(`${r.email}: ${r.msg}`, 'error'));
      setSelectedUsers([]);
      setUserSearch('');
    },
  });

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const unregisterMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      qc.refetchQueries({ queryKey: ['session-participants', sessionId] });
      qc.refetchQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['my-sessions'] });
      addToast('Unregistered from event', 'success');
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error?.message || 'Failed to unregister';
      addToast(msg, 'error');
    },
  });

  if (isLoading) return <PageLoader />;

  // 403 — user isn't registered, not a pod member, and the pod isn't public.
  // Show a clean access-denied card instead of the broken "0 participants" fallback.
  if ((sessionError as any)?.response?.status === 403) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/dashboard')} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
            <ArrowLeft className="h-4 w-4" /> Back to Dashboard
          </button>
        </div>
        <Card className="animate-fade-in-up">
          <div className="flex flex-col items-center text-center py-10 px-4">
            <div className="h-14 w-14 rounded-full bg-amber-100 flex items-center justify-center mb-4">
              <AlertTriangle className="h-7 w-7 text-amber-600" />
            </div>
            <h1 className="text-xl font-bold text-[#1a1a2e] mb-2">Access restricted</h1>
            <p className="text-gray-500 text-sm max-w-md">
              You don't have access to this event. Ask the host for an invite or join the pod to see details.
            </p>
            <Button variant="primary" onClick={() => navigate('/dashboard')} className="mt-6">
              Back to Dashboard
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!session) return <p className="text-gray-500 text-center py-20">Event not found</p>;

  const statusVariant = sessionStatusColor(session.status);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/sessions')} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Events
        </button>
        {session?.podId && pod && (
          <button onClick={() => navigate(`/pods/${session.podId}`)} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
            <ArrowLeft className="h-4 w-4" /> Back to Pod
          </button>
        )}
      </div>

      {/* Session Info */}
      <Card className="animate-fade-in-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a2e]">{session.title || 'Event'}</h1>
            {session.description && <p className="text-gray-500 mt-1 text-sm">{session.description}</p>}
            <p className="text-gray-400 mt-2 text-sm flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {session.scheduledAt ? `${formatDateTime(session.scheduledAt)} ${LOCAL_TIME_LABEL}` : 'No date set'}
            </p>
          </div>
          <Badge variant={statusVariant}>{sessionStatusLabel(session.status)}</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t border-gray-200">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-gray-500 mb-1">
              <Users className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-[#1a1a2e]">{(participants || []).length}</p>
            <p className="text-xs text-gray-400">participants</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-gray-500 mb-1">
              <Settings className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-[#1a1a2e]">{session.config?.numberOfRounds || 5}</p>
            <p className="text-xs text-gray-400">rounds</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-gray-500 mb-1">
              <Clock className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-[#1a1a2e]">{Math.floor((session.config?.roundDurationSeconds || 480) / 60)}m</p>
            <p className="text-xs text-gray-400">per round</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-gray-500 mb-1">
              <Users className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-[#1a1a2e]">{session.config?.maxParticipants || 500}</p>
            <p className="text-xs text-gray-400">max capacity</p>
          </div>
        </div>
      </Card>

      {/* Late-join warning */}
      {(session.status === 'lobby_open' || session.status === 'round_active' || session.status === 'round_rating' || session.status === 'round_transition') && !isRegistered && (
        <div className="flex items-start gap-3 rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3 animate-fade-in-up stagger-1">
          <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-300">Event in progress</p>
            <p className="text-xs text-amber-400/80 mt-0.5">
              {session.status === 'round_active' ? `Round ${session.currentRound || '?'} is currently active. ` : ''}
              You can still join — you'll be placed in the lobby until the next round begins.
            </p>
          </div>
        </div>
      )}

      {/* Actions — status-driven primary + overflow menu (April 17 item #10) */}
      <div className="flex flex-col gap-3 animate-fade-in-up stagger-1">
        {/* Primary Actions */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Non-host participant flows: Register / Join Late / Pending-invite notice */}
          {!isHost && sessionStatusPhase(session.status) !== 'done' && sessionStatusPhase(session.status) !== 'cancelled' && !isRegistered && (
            canRegister ? (
              <Button onClick={() => registerMutation.mutate()} isLoading={registerMutation.isPending} className="btn-glow">
                <UserPlus className="h-4 w-4 mr-2" /> {session.status === 'scheduled' ? 'Register' : 'Join Late'}
              </Button>
            ) : (
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
                <Mail className="h-4 w-4 flex-shrink-0" />
                <span>You have a pending invite — accept it from your <button onClick={() => navigate('/invites')} className="underline font-medium hover:text-amber-900">Invites page</button> to join this event.</span>
              </div>
            )
          )}
          {!isHost && isRegistered && sessionStatusPhase(session.status) === 'live' && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              <CheckCircle className="h-4 w-4" /> Registered
            </div>
          )}
          {!isHost && isRegistered && sessionStatusPhase(session.status) === 'pre' && (
            <>
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
                <CheckCircle className="h-4 w-4" /> Registered
              </div>
              <Button variant="ghost" onClick={() => {
                if (!confirm('Are you sure you want to unregister? You will need to register again or get a new invite to rejoin.')) return;
                unregisterMutation.mutate();
              }} isLoading={unregisterMutation.isPending}>
                <UserMinus className="h-4 w-4 mr-2" /> Unregister
              </Button>
            </>
          )}

          {/* Status-driven primary button:
              pre  -> Enter Event   (host Go Live / participant Enter Event)
              live -> Enter Live Event
              done -> View Recap
           */}
          {(isRegistered || isHost) && sessionStatusPhase(session.status) === 'pre' && (
            <Button
              variant="primary"
              onClick={() => navigate(`/session/${sessionId}/live`)}
              className="btn-glow"
            >
              <Play className="h-4 w-4 mr-2" />
              {isHost ? 'Go Live' : 'Enter Event'}
            </Button>
          )}
          {(isRegistered || isHost) && sessionStatusPhase(session.status) === 'live' && (
            <Button
              variant="primary"
              onClick={() => navigate(`/session/${sessionId}/live`)}
              className="btn-glow"
            >
              <Play className="h-4 w-4 mr-2" /> Enter Live Event
            </Button>
          )}
          {sessionStatusPhase(session.status) === 'done' && (
            <Button variant="primary" className="btn-glow" onClick={() => navigate(`/sessions/${sessionId}/recap`)}>
              View Recap
            </Button>
          )}

          {/* Overflow menu for host/admin. Host Controls button intentionally removed —
              live host controls live inside the /live page once the host clicks Enter Live Event. */}
          {(isHost || isAdmin) && sessionStatusPhase(session.status) !== 'cancelled' && (
            <div className="relative ml-auto" data-overflow-menu>
              <button
                type="button"
                aria-label="Manage event"
                onClick={() => setOverflowOpen(v => !v)}
                className="h-9 px-3 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
              >
                <Settings className="h-4 w-4" />
                <span>Manage</span>
                <svg className={`h-3.5 w-3.5 transition-transform ${overflowOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd"/></svg>
              </button>
              {overflowOpen && (
                <>
                  {/* Transparent backdrop — click anywhere outside menu closes it */}
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setOverflowOpen(false)}
                    aria-hidden="true"
                  />
                  <div
                    className="absolute right-0 mt-1 w-52 rounded-lg border border-gray-200 bg-white shadow-lg z-20 py-1"
                  >
                  <button
                    type="button"
                    onClick={() => { setOverflowOpen(false); duplicateMutation.mutate(); }}
                    disabled={duplicateMutation.isPending}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                  >
                    <CopyPlus className="h-4 w-4" /> Copy Event
                  </button>
                  {sessionStatusPhase(session.status) === 'pre' && (
                    <button
                      type="button"
                      onClick={() => { setOverflowOpen(false); openEdit(); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <Pencil className="h-4 w-4" /> Edit Event
                    </button>
                  )}
                  {sessionStatusPhase(session.status) !== 'done' && (
                    <button
                      type="button"
                      onClick={() => { setOverflowOpen(false); setInviteLink(''); setInviteEmail(''); setInviteOpen(true); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <Mail className="h-4 w-4" /> Invite to Event
                    </button>
                  )}
                  {sessionStatusPhase(session.status) !== 'live' && (
                    <button
                      type="button"
                      onClick={() => {
                        setOverflowOpen(false);
                        if (confirm('Delete this event? This cannot be undone.')) deleteMutation.mutate();
                      }}
                      disabled={deleteMutation.isPending}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60"
                    >
                      <Trash2 className="h-4 w-4" /> Delete
                    </button>
                  )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Participants */}
      <div className="animate-fade-in-up stagger-2">
        <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-rsn-red" /> Participants ({participantCounts?.total ?? (participants || []).filter((p: any) => p.status !== 'removed' && p.userId !== session.hostUserId).length})
        </h2>

        {/* Status summary row (host/admin only) */}
        {(isHost || isAdmin) && participantCounts && (
          <div className="flex flex-wrap gap-2 mb-3">
            {[
              { key: null, label: 'All', count: participantCounts.total, color: 'bg-gray-100 text-gray-700 border-gray-200' },
              ...(participantCounts.registered > 0 ? [{ key: 'registered', label: 'Registered', count: participantCounts.registered, color: 'bg-blue-50 text-blue-700 border-blue-200' }] : []),
              ...(participantCounts.checked_in > 0 ? [{ key: 'checked_in', label: 'Checked In', count: participantCounts.checked_in, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' }] : []),
              ...(participantCounts.in_lobby > 0 ? [{ key: 'in_lobby', label: 'In Main Room', count: participantCounts.in_lobby, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' }] : []),
              ...(participantCounts.in_round > 0 ? [{ key: 'in_round', label: 'In Round', count: participantCounts.in_round, color: 'bg-green-50 text-green-700 border-green-200' }] : []),
              ...(participantCounts.disconnected > 0 ? [{ key: 'disconnected', label: 'Disconnected', count: participantCounts.disconnected, color: 'bg-amber-50 text-amber-700 border-amber-200' }] : []),
              ...(participantCounts.left > 0 ? [{ key: 'left', label: 'Left', count: participantCounts.left, color: 'bg-gray-100 text-gray-500 border-gray-200' }] : []),
              ...(participantCounts.no_show > 0 ? [{ key: 'no_show', label: 'No Show', count: participantCounts.no_show, color: 'bg-red-50 text-red-600 border-red-200' }] : []),
              ...(participantCounts.pendingInvites > 0 ? [{ key: 'pending_invite', label: 'Pending Invites', count: participantCounts.pendingInvites, color: 'bg-purple-50 text-purple-700 border-purple-200' }] : []),
            ].map((tab: any) => (
              <button
                key={tab.key ?? 'all'}
                onClick={() => {
                  if (tab.key === 'pending_invite') {
                    setShowPendingInvites(!showPendingInvites);
                    setStatusFilter(null);
                  } else {
                    setShowPendingInvites(false);
                    setStatusFilter(tab.key);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                  (tab.key === 'pending_invite' ? showPendingInvites : statusFilter === tab.key)
                    ? 'ring-2 ring-rsn-red/30 border-rsn-red ' + tab.color
                    : tab.color + ' hover:opacity-80'
                }`}
              >
                {tab.key === 'pending_invite' && <Send className="h-3 w-3" />}
                <span>{tab.label}</span>
                <span className="font-bold">{tab.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Pending invites list (shown when tab is active) */}
        {showPendingInvites && (
          <div className="mb-4">
            {!pendingInvites || pendingInvites.length === 0 ? (
              <Card>
                <p className="text-gray-400 text-sm text-center py-4">No pending invites</p>
              </Card>
            ) : (
              <div className="space-y-2">
                {/* Remind All button */}
                {pendingInvites.filter((inv: any) => inv.inviteeEmail).length > 1 && (
                  <div className="flex justify-end mb-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => remindAllMutation.mutate()}
                      isLoading={remindAllMutation.isPending}
                      className="!border-purple-300 !text-purple-700 hover:!bg-purple-100"
                    >
                      <Send className="h-3.5 w-3.5 mr-1" /> Remind All ({pendingInvites.filter((inv: any) => inv.inviteeEmail).length})
                    </Button>
                  </div>
                )}
                <div className="grid gap-2">
                {pendingInvites.map((inv: any) => (
                  <Card key={inv.id} className="!p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 text-xs font-bold">
                          {(inv.inviteeName || inv.inviteeEmail || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-800">{inv.inviteeName || inv.inviteeEmail || 'Shareable link'}</p>
                          {inv.inviteeName && inv.inviteeEmail && (
                            <p className="text-xs text-gray-400">{inv.inviteeEmail}</p>
                          )}
                          <p className="text-xs text-gray-400">Sent {new Date(inv.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="warning" className="text-xs">Pending</Badge>
                        {inv.inviteeEmail && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => remindMutation.mutate(inv.id)}
                            isLoading={remindMutation.isPending}
                          >
                            <Send className="h-3 w-3 mr-1" /> Remind
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
              </div>
            )}
          </div>
        )}

        {!showPendingInvites && ((participants || []).length === 0 ? (
          <Card>
            <p className="text-gray-400 text-sm text-center py-4">No participants yet. Be the first to register!</p>
          </Card>
        ) : (
          <div className="grid gap-2">
            {(participants || [])
              .filter((p: any) => p.status !== 'removed' && p.userId !== session.hostUserId)
              .filter((p: any) => statusFilter === null || p.status === statusFilter)
              .map((p: any) => {
              const pIsHost = false;
              const statusLabel = pIsHost ? 'Host'
                : (p.status === 'registered' || p.status === 'left' || p.status === 'checked_in') ? 'Member'
                : p.status === 'in_lobby' ? 'In Main Room'
                : p.status === 'in_round' ? 'In Round'
                : p.status === 'disconnected' ? 'Reconnecting...'
                : p.status === 'no_show' ? 'No Show'
                : p.status || 'Member';
              return (
                <Card key={p.userId || p.id} className="!p-4">
                  <div className="flex items-center justify-between">
                    <a href={`/profile/${p.userId || p.id}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                      <Avatar src={p.avatarUrl} name={p.displayName || p.email || 'User'} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-gray-800">{p.displayName || p.email || 'Participant'}</p>
                        <p className="text-xs text-gray-400">{statusLabel}</p>
                      </div>
                    </a>
                    {pIsHost && (
                      <Badge variant="brand" className="text-xs">Host</Badge>
                    )}
                  </div>
                </Card>
              );
            })}
            {/* Show pending invites in "All" view so the count matches */}
            {statusFilter === null && (isHost || isAdmin) && pendingInvites && pendingInvites.length > 0 && pendingInvites.map((inv: any) => (
              <Card key={`inv-${inv.id}`} className="!p-4 opacity-70">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 text-xs font-bold">
                      {(inv.inviteeName || inv.inviteeEmail || '?').charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-500">{inv.inviteeName || inv.inviteeEmail || 'Invited user'}</p>
                      <p className="text-xs text-gray-400">Invite pending</p>
                    </div>
                  </div>
                  <Badge variant="warning" className="text-xs">Invite Pending</Badge>
                </div>
              </Card>
            ))}
          </div>
        ))}
      </div>

      {/* Invite to Session Modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite to Event">
        <div className="space-y-5">
          {/* Pod Members — invite individually or all at once */}
          {session?.podId && isHost && (
            <div className="rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-[#1a1a2e]">Invite Pod Members</h3>
                  <p className="text-xs text-gray-500">Invite members from this event's pod.</p>
                </div>
                {podMembers && podMembers.length > 0 && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={async () => {
                      setInvitingMember('all');
                      try {
                        const emails = podMembers.map((m: any) => m.email);
                        const res = await api.post('/invites/bulk', { sessionId, emails });
                        const r = res.data?.data;
                        addToast(`Invited ${r?.sent || 0} pod members!${r?.skipped ? ` ${r.skipped} already invited.` : ''}`, 'success');
                        refetchPodMembers();
                      } catch (err: any) {
                        addToast(err?.response?.data?.error?.message || 'Failed to invite', 'error');
                      } finally {
                        setInvitingMember(null);
                      }
                    }}
                    disabled={invitingMember === 'all'}
                    isLoading={invitingMember === 'all'}
                  >
                    Invite All ({podMembers.length})
                  </Button>
                )}
              </div>
              {!podMembers ? (
                <p className="text-xs text-gray-400">Loading...</p>
              ) : podMembers.length === 0 ? (
                <p className="text-xs text-gray-400">All pod members have already been invited or registered.</p>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {podMembers.map((m: any) => (
                    <div key={m.userId} className="flex items-center justify-between p-2 rounded-lg hover:bg-gray-50 transition-colors">
                      <div className="flex items-center gap-3">
                        {m.avatarUrl ? (
                          <img src={m.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                        ) : (
                          <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center text-sm text-gray-600 font-medium">
                            {m.displayName?.[0]?.toUpperCase() || '?'}
                          </div>
                        )}
                        <div>
                          <span className="text-sm text-gray-800 font-medium">{m.displayName || 'Unknown'}</span>
                          <p className="text-xs text-gray-400">{m.email}</p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => invitePodMember(m.userId, m.email)}
                        disabled={invitingMember === m.userId}
                        isLoading={invitingMember === m.userId}
                      >
                        Invite
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Option 1: Send Email Invite */}
          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[#1a1a2e]">Option 1 — Send Email Invite</h3>
            <p className="text-xs text-gray-500">Enter their email and we'll send the invite directly.</p>
            <Input label="Email Address" type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="user@example.com" />
            <Button
              onClick={() => createSessionInviteMutation.mutate({ inviteeEmail: inviteEmail || undefined })}
              isLoading={createSessionInviteMutation.isPending}
              disabled={!inviteEmail}
              className="w-full"
            >
              <Mail className="h-4 w-4 mr-2" /> Send Invite Email
            </Button>
          </div>

          {/* Option 2: Invite platform users */}
          {isHost && (
            <div className="rounded-lg border border-gray-200 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-[#1a1a2e]">Option 2 — Invite Platform Users</h3>
              <p className="text-xs text-gray-500">Search for existing users and invite them directly.</p>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <input
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  placeholder="Search by name or email..."
                  className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
                />
              </div>
              {debouncedUserSearch.length >= 1 && searchResults && searchResults.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-2">No connected users match. You can only invite people you've met in a previous event.</p>
              )}
              {searchResults && searchResults.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {/* Select All */}
                  {(() => {
                    const invitable = searchResults.filter((u: any) => !(participants || []).some((p: any) => p.userId === u.id));
                    const allSelected = invitable.length > 0 && invitable.every((u: any) => selectedUsers.some(s => s.id === u.id));
                    return invitable.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (allSelected) {
                            const invitableIds = new Set(invitable.map((u: any) => u.id));
                            setSelectedUsers(prev => prev.filter(s => !invitableIds.has(s.id)));
                          } else {
                            const existing = new Set(selectedUsers.map(s => s.id));
                            const toAdd = invitable.filter((u: any) => !existing.has(u.id));
                            setSelectedUsers(prev => [...prev, ...toAdd]);
                          }
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2 text-left text-xs font-semibold text-gray-500 bg-gray-50 hover:bg-gray-100 transition-colors"
                      >
                        <div className={`h-4 w-4 rounded border ${allSelected ? 'bg-rsn-red border-rsn-red' : 'border-gray-300'} flex items-center justify-center`}>
                          {allSelected && <Check className="h-3 w-3 text-white" />}
                        </div>
                        Select All ({invitable.length})
                      </button>
                    ) : null;
                  })()}
                  {searchResults.map((u: any) => {
                    const isParticipant = (participants || []).some((p: any) => p.userId === u.id);
                    const isSelected = !isParticipant && selectedUsers.some(s => s.id === u.id);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        disabled={isParticipant}
                        onClick={() => !isParticipant && setSelectedUsers(prev => isSelected ? prev.filter(s => s.id !== u.id) : [...prev, u])}
                        className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${isParticipant ? 'opacity-60 cursor-not-allowed bg-gray-50' : isSelected ? 'bg-rsn-red-light hover:bg-rsn-red-100' : 'hover:bg-gray-50'}`}
                      >
                        {!isParticipant && (
                          <div className={`h-4 w-4 rounded border ${isSelected ? 'bg-rsn-red border-rsn-red' : 'border-gray-300'} flex items-center justify-center`}>
                            {isSelected && <Check className="h-3 w-3 text-white" />}
                          </div>
                        )}
                        <span className={`font-medium truncate ${isParticipant ? 'text-gray-400' : 'text-gray-800'}`}>{u.displayName || u.email}</span>
                        {isParticipant && (
                          <span className="ml-auto text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">Already registered</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {selectedUsers.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">{selectedUsers.length} user(s) selected</p>
                  <Button
                    size="sm"
                    onClick={() => bulkInviteMutation.mutate(selectedUsers.map(u => u.email))}
                    isLoading={bulkInviteMutation.isPending}
                    className="w-full"
                  >
                    <Mail className="h-4 w-4 mr-2" /> Send {selectedUsers.length} Invite(s)
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-200" />
            <span className="text-xs font-medium text-gray-400 uppercase">or</span>
            <div className="h-px flex-1 bg-gray-200" />
          </div>

          {/* Option 3: Generate Shareable Link */}
          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[#1a1a2e]">Option 3 — Generate Shareable Link</h3>
            <p className="text-xs text-gray-500">Create a reusable link to share manually (up to 10 uses, expires in 7 days).</p>
            {!inviteLink ? (
              <Button
                variant="secondary"
                onClick={() => createSessionInviteMutation.mutate({})}
                isLoading={createSessionInviteMutation.isPending}
                className="w-full"
              >
                <Copy className="h-4 w-4 mr-2" /> Generate Link
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input readOnly value={inviteLink} className="flex-1 rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm" />
                  <Button variant="secondary" onClick={handleCopyLink}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-gray-400">Link copied or ready to share. Up to 10 uses, expires in 7 days.</p>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Event">
        <form onSubmit={e => {
          e.preventDefault();
          const body: any = {};
          if (editTitle) body.title = editTitle;
          if (editDescription !== undefined) body.description = editDescription;
          if (editScheduledAt) body.scheduledAt = new Date(editScheduledAt).toISOString();
          body.config = {
            numberOfRounds: editNumberOfRounds,
            roundDurationSeconds: editRoundDurationMinutes * 60,
            timerVisibility: editTimerVisibility,
            maxParticipants: editMaxParticipants,
            ...(editMatchingTemplateId && { matchingTemplateId: editMatchingTemplateId }),
          };
          updateMutation.mutate(body);
        }} className="space-y-4">
          <Input label="Title" value={editTitle} onChange={e => setEditTitle(e.target.value)} required />
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Description</label>
            <textarea
              className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
              rows={3} value={editDescription} onChange={e => setEditDescription(e.target.value)}
            />
          </div>
          <Input label="Scheduled At" type="datetime-local" value={editScheduledAt} onChange={e => setEditScheduledAt(e.target.value)} />

          {/* Timing Configuration — matches Create Event form */}
          <div className="border-t border-gray-200 pt-4 mt-4">
            <h3 className="text-sm font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
              <Clock className="h-4 w-4 text-rsn-red" /> Timing Configuration
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Number of Rounds</label>
                <input
                  type="number" min={1} max={20} value={editNumberOfRounds}
                  onChange={e => setEditNumberOfRounds(Number(e.target.value))}
                  className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
                />
                <p className="text-xs text-gray-400 mt-1">1 – 20 rounds</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Round Duration (minutes)</label>
                <input
                  type="number" min={1} max={60} value={editRoundDurationMinutes}
                  onChange={e => setEditRoundDurationMinutes(Number(e.target.value))}
                  className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
                />
                <p className="text-xs text-gray-400 mt-1">1 – 60 minutes per round</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Timer Visibility</label>
                <select
                  value={editTimerVisibility}
                  onChange={e => setEditTimerVisibility(e.target.value)}
                  className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
                >
                  <option value="always_visible">Always visible</option>
                  <option value="hidden">Hidden</option>
                  <option value="last_10s">Show last 10 seconds</option>
                  <option value="last_30s">Show last 30 seconds</option>
                  <option value="last_60s">Show last 60 seconds</option>
                  <option value="last_120s">Show last 2 minutes</option>
                </select>
                <p className="text-xs text-gray-400 mt-1">When participants can see the countdown</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Matching Template</label>
                <select
                  value={editMatchingTemplateId}
                  onChange={e => setEditMatchingTemplateId(e.target.value)}
                  className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
                >
                  <option value="">Default (balanced)</option>
                  {(templates || []).map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">How participants are matched — affects scoring weights</p>
              </div>
            </div>
          </div>

          {/* Capacity */}
          <div className="border-t border-gray-200 pt-4 mt-4">
            <h3 className="text-sm font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
              <Users className="h-4 w-4 text-rsn-red" /> Capacity
            </h3>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Max Participants</label>
              <input
                type="number" min={2} max={10000} value={editMaxParticipants}
                onChange={e => setEditMaxParticipants(Number(e.target.value))}
                className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
              />
              <p className="text-xs text-gray-400 mt-1">2 – 10,000 participants</p>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={updateMutation.isPending}>Save</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
