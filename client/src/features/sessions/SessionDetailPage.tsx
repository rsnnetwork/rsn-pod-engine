import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calendar, Users, Play, Clock, UserPlus, UserMinus, Settings, CheckCircle, Pencil, Trash2, Mail, Copy, Check, AlertTriangle } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

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
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
  });

  const { data: participants } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then(r => r.data.data ?? []),
    enabled: !!sessionId,
  });

  const isHost = session?.hostUserId === user?.id || user?.role === 'admin' || user?.role === 'super_admin';
  const isRegistered = (participants || []).some((p: any) => p.userId === user?.id);

  const updateMutation = useMutation({
    mutationFn: (body: { title?: string; description?: string; scheduledAt?: string }) => api.put(`/sessions/${sessionId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Session updated', 'success');
      setEditOpen(false);
    },
    onError: () => addToast('Failed to update session', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}`),
    onSuccess: () => {
      addToast('Session deleted', 'success');
      navigate('/sessions');
    },
    onError: () => addToast('Failed to delete session', 'error'),
  });

  const openEdit = () => {
    setEditTitle(session?.title || '');
    setEditDescription(session?.description || '');
    setEditScheduledAt(session?.scheduledAt ? new Date(session.scheduledAt).toISOString().slice(0, 16) : '');
    setEditOpen(true);
  };

  const registerMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Registered for session!', 'success');
    },
    onError: () => addToast('Failed to register', 'error'),
  });

  const createSessionInviteMutation = useMutation({
    mutationFn: (body: { inviteeEmail?: string }) =>
      api.post('/invites', { type: 'session', sessionId, ...body }),
    onSuccess: (res: any) => {
      const code = res.data?.data?.code;
      if (code) setInviteLink(`${window.location.origin}/invite/${code}`);
      addToast('Session invite created', 'success');
    },
    onError: () => addToast('Failed to create invite', 'error'),
  });

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const unregisterMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Unregistered from session', 'success');
    },
    onError: () => addToast('Failed to unregister', 'error'),
  });

  if (isLoading) return <PageLoader />;
  if (!session) return <p className="text-gray-500 text-center py-20">Session not found</p>;

  const statusVariant = session.status === 'scheduled' ? 'info'
    : session.status === 'lobby_open' || session.status === 'round_active' ? 'success'
    : session.status === 'completed' ? 'default' : 'warning';

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate('/sessions')} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Sessions
      </button>

      {/* Session Info */}
      <Card className="animate-fade-in-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a2e]">{session.title || 'Session'}</h1>
            {session.description && <p className="text-gray-500 mt-1 text-sm">{session.description}</p>}
            <p className="text-gray-400 mt-2 text-sm flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {session.scheduledAt ? new Date(session.scheduledAt).toLocaleString() : 'No date set'}
            </p>
          </div>
          <Badge variant={statusVariant}>{session.status?.replace(/_/g, ' ')}</Badge>
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
            <p className="text-sm font-medium text-amber-300">Session in progress</p>
            <p className="text-xs text-amber-400/80 mt-0.5">
              {session.status === 'round_active' ? `Round ${session.currentRound || '?'} is currently active. ` : ''}
              You can still join — you'll be placed in the lobby until the next round begins.
            </p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
        {(session.status === 'scheduled' || session.status === 'lobby_open' || session.status === 'round_active' || session.status === 'round_rating' || session.status === 'round_transition') && !isRegistered && (
          <Button onClick={() => registerMutation.mutate()} isLoading={registerMutation.isPending} className="btn-glow">
            <UserPlus className="h-4 w-4 mr-2" /> {session.status === 'scheduled' ? 'Register' : 'Join Late'}
          </Button>
        )}
        {isRegistered && session.status !== 'completed' && session.status !== 'cancelled' && (
          <>
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              <CheckCircle className="h-4 w-4" /> Registered
            </div>
            {session.status === 'scheduled' && (
              <Button variant="ghost" onClick={() => unregisterMutation.mutate()} isLoading={unregisterMutation.isPending}>
                <UserMinus className="h-4 w-4 mr-2" /> Unregister
              </Button>
            )}
          </>
        )}
        {(session.status === 'scheduled' || session.status === 'lobby_open' || session.status === 'round_active' || session.status === 'round_rating' || session.status === 'round_transition') && (
          <Button
            variant={isRegistered ? 'primary' : 'secondary'}
            onClick={() => navigate(`/session/${sessionId}/live`)}
          >
            <Play className="h-4 w-4 mr-2" />
            {session.status === 'scheduled'
              ? (isHost ? 'Start Session' : 'Enter Lobby')
              : 'Join Live'}
          </Button>
        )}
        {isHost && (
          <Button variant="secondary" onClick={() => navigate(`/session/${sessionId}/host`)}>
            <Settings className="h-4 w-4 mr-2" /> Host Controls
          </Button>
        )}
        {isHost && session.status === 'scheduled' && (
          <Button variant="secondary" onClick={openEdit}>
            <Pencil className="h-4 w-4 mr-2" /> Edit
          </Button>
        )}
        {isHost && (session.status === 'scheduled' || session.status === 'completed') && (
          <Button variant="danger" onClick={() => { if (confirm('Delete this session? This cannot be undone.')) deleteMutation.mutate(); }} isLoading={deleteMutation.isPending}>
            <Trash2 className="h-4 w-4 mr-2" /> Delete
          </Button>
        )}
        {session.status === 'completed' && (
          <Button variant="secondary" onClick={() => navigate(`/sessions/${sessionId}/recap`)}>
            View Recap
          </Button>
        )}
        {isHost && session.status !== 'completed' && (
          <Button variant="secondary" onClick={() => { setInviteLink(''); setInviteEmail(''); setInviteOpen(true); }}>
            <Mail className="h-4 w-4 mr-2" /> Invite to Session
          </Button>
        )}
      </div>

      {/* Participants */}
      <div className="animate-fade-in-up stagger-2">
        <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-indigo-600" /> Participants ({(participants || []).length})
        </h2>
        {(participants || []).length === 0 ? (
          <Card>
            <p className="text-gray-400 text-sm text-center py-4">No participants yet. Be the first to register!</p>
          </Card>
        ) : (
          <div className="grid gap-2">
            {(participants || []).map((p: any) => (
              <Card key={p.userId || p.id} className="!p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={p.displayName || p.email || 'User'} size="sm" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{p.displayName || p.email || 'Participant'}</p>
                      <p className="text-xs text-gray-400">{p.status || 'registered'}</p>
                    </div>
                  </div>
                  {p.userId === session.hostUserId && (
                    <Badge variant="brand" className="text-xs">Host</Badge>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Invite to Session Modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite to Session">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">Create an invite link to share with people you want in this session.</p>
          <Input label="Invitee Email (optional)" type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="user@example.com" />
          <Button onClick={() => createSessionInviteMutation.mutate({ inviteeEmail: inviteEmail || undefined })} isLoading={createSessionInviteMutation.isPending} className="w-full">
            Generate Invite Link
          </Button>
          {inviteLink && (
            <div className="mt-4 space-y-2">
              <label className="block text-sm font-medium text-gray-600">Share this link:</label>
              <div className="flex gap-2">
                <input readOnly value={inviteLink} className="flex-1 rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm" />
                <Button variant="secondary" onClick={handleCopyLink}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-gray-400">This link allows up to 10 uses and expires in 7 days.</p>
            </div>
          )}
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Session">
        <form onSubmit={e => {
          e.preventDefault();
          const body: any = {};
          if (editTitle) body.title = editTitle;
          if (editDescription !== undefined) body.description = editDescription;
          if (editScheduledAt) body.scheduledAt = new Date(editScheduledAt).toISOString();
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={updateMutation.isPending}>Save</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
