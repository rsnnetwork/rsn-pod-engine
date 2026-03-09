import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Users, Calendar, LogOut, Shield, UserMinus, Eye, Radio, Pencil, Trash2, UserPlus } from 'lucide-react';
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
const visibilityIcons: Record<string, string> = {
  private: 'Private', invite_only: 'Invite Only', public: 'Public',
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

  const openEdit = () => {
    setEditName(pod?.name || '');
    setEditDescription(pod?.description || '');
    setEditOpen(true);
  };

  if (isLoading) return <PageLoader />;
  if (!pod) return <p className="text-surface-400 text-center py-20">Pod not found</p>;

  const membersList = members || pod.members || [];
  const myMembership = membersList.find((m: any) => m.userId === user?.id);
  const isMember = !!myMembership || !!pod.memberRole;
  const isDirector = myMembership?.role === 'director' || pod.memberRole === 'director' || user?.role === 'admin';

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate('/pods')} className="flex items-center gap-2 text-surface-400 hover:text-surface-200 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Pods
      </button>

      {/* Pod Header */}
      <Card className="animate-fade-in-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-surface-100">{pod.name}</h1>
            <p className="text-surface-400 mt-1">{pod.description || 'General focus'}</p>
          </div>
          <Badge variant={pod.status === 'active' ? 'success' : 'default'}>{pod.status}</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mt-4 pt-4 border-t border-surface-800">
          <div className="flex items-center gap-2 text-sm text-surface-400">
            <Users className="h-4 w-4 text-brand-400" />
            <span>{membersList.length} members</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-surface-400">
            <Calendar className="h-4 w-4 text-brand-400" />
            <span>{sessionCountData || 0} sessions</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-surface-400">
            <Radio className="h-4 w-4 text-brand-400" />
            <span>{podTypeLabels[pod.podType] || pod.podType}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-surface-400">
            <Eye className="h-4 w-4 text-brand-400" />
            <span>{visibilityIcons[pod.visibility] || pod.visibility}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-surface-400">
            <Calendar className="h-4 w-4 text-brand-400" />
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
      {!isMember && pod.status === 'active' ? (
        <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
          <Button onClick={() => joinMutation.mutate()} isLoading={joinMutation.isPending} className="btn-glow">
            <UserPlus className="h-4 w-4 mr-2" /> Join Pod
          </Button>
          <p className="text-sm text-surface-500 self-center">Join this pod to participate in sessions and meet members.</p>
        </div>
      ) : pod.status === 'archived' ? (
        <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
          {isDirector && (
            <Button onClick={() => reactivateMutation.mutate()} isLoading={reactivateMutation.isPending} className="btn-glow">
              Reactivate Pod
            </Button>
          )}
          <p className="text-sm text-surface-500 self-center">This pod is archived. Sessions and data are preserved.</p>
        </div>
      ) : pod.status !== 'archived' && (
        <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
          <Button onClick={() => navigate(`/sessions/new?podId=${podId}`)} className="btn-glow">
            <Calendar className="h-4 w-4 mr-2" /> Schedule Session
          </Button>
          {isDirector && (
            <Button variant="secondary" onClick={openEdit}>
              <Pencil className="h-4 w-4 mr-2" /> Edit Pod
            </Button>
          )}
          {isDirector && (
            <Button variant="danger" onClick={() => { if (confirm('Archive this pod? Sessions will be preserved and you can reactivate later.')) deleteMutation.mutate(); }} isLoading={deleteMutation.isPending}>
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
            <label className="block text-sm font-medium text-surface-300 mb-1">Description</label>
            <textarea
              className="w-full rounded-lg bg-surface-800 border border-surface-700 px-3 py-2 text-surface-200 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              rows={3} value={editDescription} onChange={e => setEditDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={updateMutation.isPending}>Save</Button>
          </div>
        </form>
      </Modal>

      {/* Members */}
      <div className="animate-fade-in-up stagger-2">
        <h2 className="text-lg font-semibold text-surface-100 mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-brand-400" /> Members ({membersList.length})
        </h2>
        <div className="grid gap-2">
          {membersList.map((m: any) => (
            <Card key={m.userId || m.id} className="!p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Avatar name={m.displayName || m.email || 'User'} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-surface-200">{m.displayName || m.email || 'Member'}</p>
                    <p className="text-xs text-surface-500">{m.role || 'member'}</p>
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
                      className="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                      title="Remove member"
                    >
                      <UserMinus className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {membersList.length === 0 && (
            <Card>
              <p className="text-surface-500 text-sm text-center py-4">No members yet</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
