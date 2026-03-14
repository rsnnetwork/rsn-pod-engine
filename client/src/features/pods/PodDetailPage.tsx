import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Users, Calendar, LogOut, Shield, UserMinus, Eye, Radio, Pencil, Trash2, UserPlus, Lock, Mail, Copy, Check, UserCheck, X, Clock, CopyPlus, Search } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

const podTypeLabels: Record<string, string> = {
  speed_networking: 'Speed Networking',
  duo: 'Duo', trio: 'Trio', kvartet: 'Kvartet',
  band: 'Band', orchestra: 'Orchestra', concert: 'Concert',
};
const visibilityLabels: Record<string, { label: string; icon: typeof Eye; color: string }> = {
  public: { label: 'Public', icon: Eye, color: 'text-emerald-400' },
  invite_only: { label: 'Invite Only', icon: Shield, color: 'text-amber-400' },
  private: { label: 'Private', icon: Lock, color: 'text-red-400' },
};

export default function PodDetailPage() {
  const { podId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [podUserSearch, setPodUserSearch] = useState('');
  const [podSelectedUsers, setPodSelectedUsers] = useState<any[]>([]);

  const { data: pod, isLoading } = useQuery({
    queryKey: ['pod', podId],
    queryFn: () => api.get(`/pods/${podId}`).then(r => r.data.data),
  });

  const { data: members } = useQuery({
    queryKey: ['pod-members', podId],
    queryFn: () => api.get(`/pods/${podId}/members`).then(r => r.data.data ?? []),
    enabled: !!podId,
  });

  const { data: sessionCountData } = useQuery({
    queryKey: ['pod-session-count', podId],
    queryFn: () => api.get(`/pods/${podId}/session-count`).then(r => r.data.data?.count ?? 0),
    enabled: !!podId,
  });

  const { data: podSearchResults } = useQuery({
    queryKey: ['user-search', podUserSearch],
    queryFn: () => api.get(`/users/search?q=${encodeURIComponent(podUserSearch)}`).then(r => r.data.data ?? []),
    enabled: podUserSearch.length >= 1,
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.post(`/pods/${podId}/leave`),
    onSuccess: () => {
      addToast('Left pod', 'success');
      navigate('/pods');
    },
    onError: () => addToast('Failed to leave pod', 'error'),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/pods/${podId}/members/${userId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      addToast('Member removed', 'success');
    },
    onError: () => addToast('Failed to remove member', 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: (body: { name?: string; description?: string }) => api.put(`/pods/${podId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] });
      addToast('Pod updated', 'success');
      setEditOpen(false);
    },
    onError: () => addToast('Failed to update pod', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/pods/${podId}`),
    onSuccess: () => {
      addToast('Pod deleted', 'success');
      navigate('/pods');
    },
    onError: () => addToast('Failed to delete pod', 'error'),
  });

  const reactivateMutation = useMutation({
    mutationFn: () => api.post(`/pods/${podId}/reactivate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] });
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      addToast('Pod reactivated', 'success');
    },
    onError: () => addToast('Failed to reactivate pod', 'error'),
  });

  const copyPodMutation = useMutation({
    mutationFn: () => api.post('/pods', {
      name: `${pod?.name || 'Pod'} (copy)`,
      description: pod?.description || '',
      podType: pod?.podType || 'speed_networking',
      orchestrationMode: pod?.orchestrationMode || 'timed_rounds',
      communicationMode: pod?.communicationMode || 'video',
      visibility: pod?.visibility || 'private',
      maxMembers: pod?.maxMembers || 50,
    }),
    onSuccess: (res: any) => {
      const newId = res.data?.data?.id;
      addToast('Pod copied! You can now edit the new pod.', 'success');
      if (newId) navigate(`/pods/${newId}`);
    },
    onError: () => addToast('Failed to copy pod', 'error'),
  });

  const joinMutation = useMutation({
    mutationFn: () => api.post(`/pods/${podId}/join`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] });
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      addToast('Joined pod!', 'success');
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Failed to join pod', 'error'),
  });

  const requestJoinMutation = useMutation({
    mutationFn: () => api.post(`/pods/${podId}/request-join`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] });
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      addToast('Join request sent! The pod director will review it.', 'success');
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Failed to request join', 'error'),
  });

  const approveMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/pods/${podId}/members/${userId}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      addToast('Member approved!', 'success');
    },
    onError: () => addToast('Failed to approve member', 'error'),
  });

  const rejectMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/pods/${podId}/members/${userId}/reject`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      addToast('Request rejected', 'success');
    },
    onError: () => addToast('Failed to reject request', 'error'),
  });

  const createInviteMutation = useMutation({
    mutationFn: (data: { inviteeEmail?: string }) => api.post('/invites', {
      type: 'pod',
      podId,
      inviteeEmail: data.inviteeEmail || undefined,
      maxUses: data.inviteeEmail ? 1 : 10,
      expiresInHours: 168,
    }),
    onSuccess: (res, variables) => {
      const code = res.data.data?.code;
      if (code) {
        const link = `${window.location.origin}/invite/${code}`;
        setInviteLink(link);
      }
      if (variables.inviteeEmail) {
        addToast(`Invite sent to ${variables.inviteeEmail}`, 'success');
        setInviteEmail('');
      } else {
        addToast('Invite link generated!', 'success');
      }
    },
    onError: () => addToast('Failed to create invite', 'error'),
  });

  const bulkPodInviteMutation = useMutation({
    mutationFn: async (emails: string[]) => {
      const results: { email: string; ok: boolean; msg?: string }[] = [];
      for (const email of emails) {
        try {
          await api.post('/invites', { type: 'pod', podId, maxUses: 1, inviteeEmail: email, expiresInHours: 168 });
          results.push({ email, ok: true });
        } catch (err: any) {
          const msg = err?.response?.data?.error?.message || 'Failed to send invite';
          results.push({ email, ok: false, msg });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      const succeeded = results.filter(r => r.ok);
      const failed = results.filter(r => !r.ok);
      if (succeeded.length > 0) addToast(`${succeeded.length} invite(s) sent!`, 'success');
      failed.forEach(r => addToast(`${r.email}: ${r.msg}`, 'error'));
      setPodSelectedUsers([]);
      setPodUserSearch('');
    },
  });

  const openEdit = () => {
    setEditName(pod?.name || '');
    setEditDescription(pod?.description || '');
    setEditOpen(true);
  };

  if (isLoading) return <PageLoader />;
  if (!pod) return <p className="text-gray-500 text-center py-20">Pod not found</p>;

  const membersList = members || pod.members || [];
  const activeMembers = membersList.filter((m: any) => m.status === 'active');
  const pendingMembers = membersList.filter((m: any) => m.status === 'pending_approval');
  const myMembership = membersList.find((m: any) => m.userId === user?.id);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const isMember = myMembership?.status === 'active' || !!pod.memberRole || isAdmin;
  const isPending = myMembership?.status === 'pending_approval';
  const isDirector = myMembership?.role === 'director' || pod.memberRole === 'director' || isAdmin;
  const isDirectorOrHost = isDirector || myMembership?.role === 'host' || pod.memberRole === 'host';
  const vis = visibilityLabels[pod.visibility] || visibilityLabels.public;
  const VisIcon = vis.icon;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate('/pods')} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Pods
      </button>

      {/* Pod Header */}
      <Card className="animate-fade-in-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a2e]">{pod.name}</h1>
            <p className="text-gray-500 mt-1">{pod.description || 'General focus'}</p>
          </div>
          <Badge variant={pod.status === 'active' ? 'success' : 'default'}>{pod.status}</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mt-4 pt-4 border-t border-gray-200">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Users className="h-4 w-4 text-indigo-600" />
            <span>{activeMembers.length} members</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Calendar className="h-4 w-4 text-indigo-600" />
            <span>{sessionCountData || 0} events</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Radio className="h-4 w-4 text-indigo-600" />
            <span>{podTypeLabels[pod.podType] || pod.podType}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <VisIcon className={`h-4 w-4 ${vis.color}`} />
            <span className={vis.color}>{vis.label}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Calendar className="h-4 w-4 text-indigo-600" />
            <span>Created {new Date(pod.createdAt).toLocaleDateString()}</span>
          </div>
        </div>

        {pod.orchestrationMode && (
          <div className="flex gap-2 mt-3">
            <Badge variant="brand">{pod.orchestrationMode?.replace(/_/g, ' ')}</Badge>
            {pod.communicationMode && <Badge>{pod.communicationMode}</Badge>}
          </div>
        )}
      </Card>

      {/* Actions */}
      {!isMember && !isPending && pod.status === 'active' ? (
        <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
          {pod.visibility === 'public' ? (
            <>
              <Button onClick={() => joinMutation.mutate()} isLoading={joinMutation.isPending} className="btn-glow">
                <UserPlus className="h-4 w-4 mr-2" /> Join Pod
              </Button>
              <p className="text-sm text-gray-400 self-center">Join this pod to participate in events and meet members.</p>
            </>
          ) : (
            <>
              <Button onClick={() => requestJoinMutation.mutate()} isLoading={requestJoinMutation.isPending} className="btn-glow">
                <UserPlus className="h-4 w-4 mr-2" /> Request to Join
              </Button>
              <p className="text-sm text-gray-400 self-center">
                {pod.visibility === 'invite_only' ? 'This pod is invite-only. Request to join or use an invite link.' : 'This is a private pod. Request access from the director.'}
              </p>
            </>
          )}
        </div>
      ) : isPending ? (
        <div className="flex items-center gap-3 animate-fade-in-up stagger-1">
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm">
            <Clock className="h-4 w-4" /> Join request pending — waiting for director approval
          </div>
        </div>
      ) : pod.status === 'archived' ? (
        <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
          {isDirector && (
            <Button onClick={() => reactivateMutation.mutate()} isLoading={reactivateMutation.isPending} className="btn-glow">
              Reactivate Pod
            </Button>
          )}
          <p className="text-sm text-gray-400 self-center">This pod is archived. Events and data are preserved.</p>
        </div>
      ) : pod.status !== 'archived' && (
        <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
          {isDirectorOrHost && (
            <Button onClick={() => navigate(`/sessions/new?podId=${podId}`)} className="btn-glow">
              <Calendar className="h-4 w-4 mr-2" /> Schedule Event
            </Button>
          )}
          {isDirectorOrHost && (
            <Button variant="secondary" onClick={() => { setInviteLink(''); setInviteEmail(''); setInviteOpen(true); }}>
              <Mail className="h-4 w-4 mr-2" /> Invite Members
            </Button>
          )}
          {isDirector && (
            <Button variant="secondary" onClick={openEdit}>
              <Pencil className="h-4 w-4 mr-2" /> Edit Pod
            </Button>
          )}
          {isDirector && (
            <Button variant="secondary" onClick={() => copyPodMutation.mutate()} isLoading={copyPodMutation.isPending}>
              <CopyPlus className="h-4 w-4 mr-2" /> Copy Pod
            </Button>
          )}
          {isDirector && (
            <Button variant="danger" onClick={() => { if (confirm('Archive this pod? Events will be preserved and you can reactivate later.')) deleteMutation.mutate(); }} isLoading={deleteMutation.isPending}>
              <Trash2 className="h-4 w-4 mr-2" /> Archive Pod
            </Button>
          )}
          {myMembership && !isDirector && (
            <Button variant="danger" onClick={() => leaveMutation.mutate()} isLoading={leaveMutation.isPending}>
              <LogOut className="h-4 w-4 mr-2" /> Leave Pod
            </Button>
          )}
        </div>
      )}

      {/* Edit Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Pod">
        <form onSubmit={e => { e.preventDefault(); updateMutation.mutate({ name: editName, description: editDescription }); }} className="space-y-4">
          <Input label="Pod Name" value={editName} onChange={e => setEditName(e.target.value)} required />
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Description</label>
            <textarea
              className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
              rows={3} value={editDescription} onChange={e => setEditDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={updateMutation.isPending}>Save</Button>
          </div>
        </form>
      </Modal>

      {/* Invite Members Modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite Members to Pod">
        <div className="space-y-5">
          {/* Option 1: Send Email Invite */}
          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[#1a1a2e]">Option 1 — Send Email Invite</h3>
            <p className="text-xs text-gray-500">Enter their email and we'll send the invite directly.</p>
            <Input label="Email Address" type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="user@example.com" />
            <Button
              onClick={() => createInviteMutation.mutate({ inviteeEmail: inviteEmail || undefined })}
              isLoading={createInviteMutation.isPending}
              disabled={!inviteEmail}
              className="w-full"
            >
              <Mail className="h-4 w-4 mr-2" /> Send Invite Email
            </Button>
          </div>

          {/* Option 2: Invite Platform Users */}
          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[#1a1a2e]">Option 2 — Invite Platform Users</h3>
            <p className="text-xs text-gray-500">Search existing users and invite them directly.</p>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                value={podUserSearch}
                onChange={e => setPodUserSearch(e.target.value)}
                placeholder="Search by name or email..."
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
              />
            </div>
            {podUserSearch.length >= 1 && podSearchResults && podSearchResults.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-2">No users found matching "{podUserSearch}"</p>
            )}
            {podSearchResults && podSearchResults.length > 0 && (
              <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                {podSearchResults.map((u: any) => {
                  const isMember = activeMembers.some((m: any) => m.userId === u.id);
                  const isSelected = !isMember && podSelectedUsers.some(s => s.id === u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      disabled={isMember}
                      onClick={() => !isMember && setPodSelectedUsers(prev => isSelected ? prev.filter(s => s.id !== u.id) : [...prev, u])}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${isMember ? 'opacity-60 cursor-not-allowed bg-gray-50' : isSelected ? 'bg-indigo-50 hover:bg-indigo-100' : 'hover:bg-gray-50'}`}
                    >
                      {!isMember && (
                        <div className={`h-4 w-4 rounded border ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'} flex items-center justify-center shrink-0`}>
                          {isSelected && <Check className="h-3 w-3 text-white" />}
                        </div>
                      )}
                      <span className={`font-medium truncate ${isMember ? 'text-gray-400' : 'text-gray-800'}`}>{u.displayName || u.email}</span>
                      {isMember && (
                        <span className="ml-auto text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">Already a member</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {podSelectedUsers.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">{podSelectedUsers.length} user(s) selected</p>
                <Button
                  size="sm"
                  onClick={() => bulkPodInviteMutation.mutate(podSelectedUsers.map(u => u.email))}
                  isLoading={bulkPodInviteMutation.isPending}
                  className="w-full"
                >
                  <Mail className="h-4 w-4 mr-2" /> Send {podSelectedUsers.length} Invite(s)
                </Button>
              </div>
            )}
          </div>

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
                onClick={() => createInviteMutation.mutate({})}
                isLoading={createInviteMutation.isPending}
                className="w-full"
              >
                <Copy className="h-4 w-4 mr-2" /> Generate Link
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    readOnly value={inviteLink}
                    className="flex-1 rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm"
                  />
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

      {/* Pending Join Requests */}
      {isDirectorOrHost && pendingMembers.length > 0 && (
        <div className="animate-fade-in-up stagger-2">
          <h2 className="text-lg font-semibold text-amber-400 mb-3 flex items-center gap-2">
            <Clock className="h-5 w-5" /> Pending Requests ({pendingMembers.length})
          </h2>
          <div className="grid gap-2">
            {pendingMembers.map((m: any) => (
              <Card key={m.userId || m.id} className="!p-4 border-amber-500/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={m.displayName || m.email || 'User'} size="sm" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{m.displayName || m.email || 'User'}</p>
                      <p className="text-xs text-amber-400">Pending approval</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => approveMutation.mutate(m.userId)} className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-all" title="Approve">
                      <UserCheck className="h-4 w-4" />
                    </button>
                    <button onClick={() => rejectMutation.mutate(m.userId)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-all" title="Reject">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Members */}
      <div className="animate-fade-in-up stagger-2">
        <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-indigo-600" /> Members ({activeMembers.length})
        </h2>
        <div className="grid gap-2">
          {activeMembers.map((m: any) => (
            <Card key={m.userId || m.id} className="!p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Avatar name={m.displayName || m.email || 'User'} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-gray-800">{m.displayName || m.email || 'Member'}</p>
                    <p className="text-xs text-gray-400">{m.role || 'member'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {(m.role === 'director' || m.role === 'host') && (
                    <Badge variant={m.role === 'director' ? 'brand' : 'info'} className="text-xs">
                      <Shield className="h-3 w-3 mr-1" /> {m.role}
                    </Badge>
                  )}
                  {isDirector && m.userId !== user?.id && (
                    <button
                      onClick={() => removeMemberMutation.mutate(m.userId)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
                      title="Remove member"
                    >
                      <UserMinus className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {activeMembers.length === 0 && (
            <Card>
              <p className="text-gray-400 text-sm text-center py-4">No members yet</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
