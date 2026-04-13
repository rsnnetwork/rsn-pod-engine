import { useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Users, Calendar, LogOut, Shield, UserMinus, Eye, Radio,
  Pencil, Trash2, UserPlus, Lock, Mail, Copy, Check, UserCheck, X,
  Clock, CopyPlus, Search, XCircle, Send, Inbox,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import ProfileCard from '@/components/ui/ProfileCard';
import { Button } from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import CreatePodModal from './CreatePodModal';

/** Map invite API error codes to user-friendly messages */
function getInviteErrorMessage(err: any): string {
  const code = err?.response?.data?.error?.code;
  const message = err?.response?.data?.error?.message;
  switch (code) {
    case 'DUPLICATE_INVITE':          return 'This person already has a pending invite';
    case 'SELF_INVITE':               return 'You cannot send an invite to yourself';
    case 'ALREADY_REGISTERED':        return 'This person already has an account on the platform';
    case 'POD_MEMBER_EXISTS':         return 'This person is already a member of this pod';
    case 'SESSION_ALREADY_REGISTERED':return 'This person is already a participant of this event';
    case 'POD_ARCHIVED':              return 'Cannot send invites to an archived pod';
    case 'AUTH_FORBIDDEN':            return message || 'You do not have permission to send this invite';
    case 'VALIDATION_ERROR':          return message || 'Please check the form and try again';
    case 'RATE_LIMIT_EXCEEDED':       return 'Too many invites sent. Please wait and try again';
    default:                          return message || 'Failed to send invite. Please try again';
  }
}

// ─── Label / icon maps ──────────────────────────────────────────────────────

const POD_TYPE_LABELS: Record<string, string> = {
  speed_networking:    'Speed Networking',
  reason:              'Reason Pod',
  conversational:      'Conversational',
  webinar:             'Webinar',
  physical_event:      'Physical Event',
  chat:                'Chat Pod',
  two_sided_networking:'Two-Sided Networking',
  one_sided_networking:'One-Sided Networking',
};

const VISIBILITY_CONFIG: Record<string, { label: string; icon: typeof Eye; color: string; desc: string }> = {
  public:              { label: 'Public',               icon: Eye,    color: 'text-emerald-400', desc: 'Anyone can join directly' },
  invite_only:         { label: 'Invite Only',          icon: Shield, color: 'text-amber-400',   desc: 'Requires an invite link' },
  private:             { label: 'Private',              icon: Lock,   color: 'text-red-400',     desc: 'Hidden, invite only' },
  public_with_approval:{ label: 'Public with Approval', icon: UserCheck, color: 'text-indigo-400', desc: 'Anyone can find and request to join; director approves' },
};

const POD_TYPES_OPTIONS = [
  { value: 'speed_networking',    label: 'Speed Networking' },
  { value: 'reason',              label: 'Reason Pod' },
  { value: 'conversational',      label: 'Conversational' },
  { value: 'webinar',             label: 'Webinar' },
  { value: 'physical_event',      label: 'Physical Event' },
  { value: 'chat',                label: 'Chat Pod' },
  { value: 'two_sided_networking', label: 'Two-Sided Networking' },
  { value: 'one_sided_networking', label: 'One-Sided Networking' },
];

const VISIBILITY_OPTIONS = [
  { value: 'private',              label: 'Private — invite only, hidden from browse' },
  { value: 'invite_only',          label: 'Invite Only — discoverable but requires invite' },
  { value: 'public_with_approval', label: 'Public with Approval — anyone can request, you approve' },
  { value: 'public',               label: 'Public — anyone can join directly' },
];

const selectClass = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';

// ─── Edit form state ─────────────────────────────────────────────────────────

interface EditForm {
  name: string;
  description: string;
  podType: string;
  orchestrationMode: string;
  communicationMode: string;
  visibility: string;
  maxMembers: number | '';
  rules: string;
  allowMemberInvites: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PodDetailPage() {
  const { podId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>({
    name: '', description: '', podType: 'speed_networking',
    orchestrationMode: 'timed_rounds', communicationMode: 'video',
    visibility: 'private', maxMembers: '', rules: '', allowMemberInvites: false,
  });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [podUserSearch, setPodUserSearch] = useState('');
  const debouncedPodSearch = useDebouncedValue(podUserSearch, 300);
  const [podSelectedUsers, setPodSelectedUsers] = useState<any[]>([]);

  const [memberStatusFilter, setMemberStatusFilter] = useState<string | null>(null);
  // Duplicate pod: open CreatePodModal pre-filled
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  // Request to join: rules agreement
  const [showJoinRules, setShowJoinRules] = useState(false);
  const [rulesAgreed, setRulesAgreed] = useState(false);

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

  const { data: podSessions } = useQuery({
    queryKey: ['pod-sessions', podId],
    queryFn: () => api.get(`/sessions?podId=${podId}`).then(r => r.data.data ?? []),
    enabled: !!podId,
  });

  const { data: podSearchResults } = useQuery({
    queryKey: ['user-search', debouncedPodSearch],
    queryFn: () => api.get(`/users/search?q=${encodeURIComponent(debouncedPodSearch)}`).then(r => r.data.data ?? []),
    enabled: debouncedPodSearch.length >= 1,
  });

  const { data: podMemberCounts } = useQuery({
    queryKey: ['pod-member-counts', podId],
    queryFn: () => api.get(`/pods/${podId}/member-counts`).then(r => r.data.data),
    enabled: !!podId,
  });

  const [showPodPendingInvites, setShowPodPendingInvites] = useState(false);
  const { data: podPendingInvites } = useQuery({
    queryKey: ['pod-pending-invites', podId],
    queryFn: () => api.get(`/invites/pod/${podId}?status=pending`).then(r => r.data.data ?? []),
    enabled: !!podId && showPodPendingInvites,
  });

  // ─── Mutations ─────────────────────────────────────────────────────────────

  const leaveMutation = useMutation({
    mutationFn: () => api.post(`/pods/${podId}/leave`),
    onSuccess: () => { addToast('Left pod', 'success'); navigate('/pods'); },
    onError: () => addToast('Failed to leave pod', 'error'),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/pods/${podId}/members/${userId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pod-members', podId] }); addToast('Member removed', 'success'); },
    onError: () => addToast('Failed to remove member', 'error'),
  });

  const changeRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch(`/pods/${podId}/members/${userId}/role`, { role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pod-members', podId] }); addToast('Member role updated', 'success'); },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Failed to update role', 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: (body: Partial<EditForm>) => api.put(`/pods/${podId}`, {
      ...body,
      maxMembers: body.maxMembers === '' ? null : Number(body.maxMembers),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] });
      addToast('Pod updated', 'success');
      setEditOpen(false);
    },
    onError: () => addToast('Failed to update pod', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/pods/${podId}`),
    onSuccess: () => { addToast('Pod archived', 'success'); navigate('/pods'); },
    onError: () => addToast('Failed to archive pod', 'error'),
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pod-members', podId] }); addToast('Member approved!', 'success'); },
    onError: () => addToast('Failed to approve member', 'error'),
  });

  const rejectMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/pods/${podId}/members/${userId}/reject`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pod-members', podId] }); addToast('Request rejected', 'success'); },
    onError: () => addToast('Failed to reject request', 'error'),
  });

  const createInviteMutation = useMutation({
    mutationFn: (data: { inviteeEmail?: string }) => api.post('/invites', {
      type: 'pod', podId,
      inviteeEmail: data.inviteeEmail || undefined,
      maxUses: data.inviteeEmail ? 1 : 10,
      expiresInHours: 168,
    }),
    onSuccess: (res, variables) => {
      const code = res.data.data?.code;
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

  const bulkPodInviteMutation = useMutation({
    mutationFn: async (emails: string[]) => {
      const results: { email: string; ok: boolean; msg?: string }[] = [];
      for (const email of emails) {
        try {
          await api.post('/invites', { type: 'pod', podId, maxUses: 1, inviteeEmail: email, expiresInHours: 168 });
          results.push({ email, ok: true });
        } catch (err: any) {
          results.push({ email, ok: false, msg: err?.response?.data?.error?.message || 'Failed' });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      const succeeded = results.filter(r => r.ok);
      const failed    = results.filter(r => !r.ok);
      if (succeeded.length > 0) addToast(`${succeeded.length} invite(s) sent!`, 'success');
      failed.forEach(r => addToast(`${r.email}: ${r.msg}`, 'error'));
      setPodSelectedUsers([]);
      setPodUserSearch('');
    },
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const openEdit = () => {
    setEditForm({
      name:              pod?.name || '',
      description:       pod?.description || '',
      podType:           pod?.podType || 'speed_networking',
      orchestrationMode: pod?.orchestrationMode || 'timed_rounds',
      communicationMode: pod?.communicationMode || 'video',
      visibility:        pod?.visibility || 'private',
      maxMembers:        pod?.maxMembers ?? '',
      rules:             pod?.rules || '',
      allowMemberInvites: pod?.allowMemberInvites ?? false,
    });
    setEditOpen(true);
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── Render guards ─────────────────────────────────────────────────────────

  if (isLoading) return <PageLoader />;
  if (!pod) return <p className="text-gray-500 text-center py-20">Pod not found</p>;

  const membersList    = members || pod.members || [];
  const activeMembers  = membersList.filter((m: any) => m.status === 'active');
  const pendingMembers = membersList.filter((m: any) => m.status === 'pending_approval');
  const declinedMembers  = membersList.filter((m: any) => m.status === 'declined');
  const noResponseMembers = membersList.filter((m: any) => m.status === 'no_response');

  const myMembership     = membersList.find((m: any) => m.userId === user?.id);
  const isAdminUser      = user?.role === 'admin' || user?.role === 'super_admin';
  const isMember         = myMembership?.status === 'active' || !!pod.memberRole || isAdminUser;
  const isPending        = myMembership?.status === 'pending_approval';
  const isDirector       = myMembership?.role === 'director' || pod.memberRole === 'director' || isAdminUser;
  const isDirectorOrHost = isDirector || myMembership?.role === 'host' || pod.memberRole === 'host';

  const vis    = VISIBILITY_CONFIG[pod.visibility] || VISIBILITY_CONFIG.public;
  const VisIcon = vis.icon;

  // Build initialValues for duplicate — strip id, rename
  const duplicateInitialValues = {
    name:              `${pod.name} (copy)`,
    description:       pod.description || '',
    podType:           pod.podType || 'speed_networking',
    orchestrationMode: pod.orchestrationMode || 'timed_rounds',
    communicationMode: pod.communicationMode || 'video',
    visibility:        pod.visibility || 'private',
    maxMembers:        pod.maxMembers ?? '',
  };

  // ─── JSX ──────────────────────────────────────────────────────────────────

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
            <p className="text-gray-500 mt-1">{pod.description || 'No description'}</p>
          </div>
          <Badge variant={pod.status === 'active' ? 'success' : 'default'}>{pod.status}</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mt-4 pt-4 border-t border-gray-200">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Users className="h-4 w-4 text-rsn-red" />
            <span>{pod.memberCount ?? activeMembers.length} members{pod.maxMembers ? ` / ${pod.maxMembers}` : ''}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Calendar className="h-4 w-4 text-rsn-red" />
            <span>{pod.sessionCount ?? sessionCountData ?? 0} events</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Radio className="h-4 w-4 text-rsn-red" />
            <span>{POD_TYPE_LABELS[pod.podType] || pod.podType}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <VisIcon className={`h-4 w-4 ${vis.color}`} />
            <span className={vis.color}>{vis.label}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Calendar className="h-4 w-4 text-rsn-red" />
            <span>Created {new Date(pod.createdAt).toLocaleDateString()}</span>
          </div>
        </div>

        {pod.directorName && (
          <div className="flex items-center gap-2 mt-3 text-sm text-gray-500">
            <Shield className="h-4 w-4 text-rsn-red" />
            <span>Director: <span className="font-medium text-[#1a1a2e]">{pod.directorName}</span></span>
          </div>
        )}

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
              <Button onClick={() => {
                const jc = pod.joinConfig;
                if (jc?.rulesText || jc?.agreementText) {
                  setShowJoinRules(true);
                  setRulesAgreed(false);
                } else {
                  requestJoinMutation.mutate();
                }
              }} isLoading={requestJoinMutation.isPending} className="btn-glow">
                <UserPlus className="h-4 w-4 mr-2" /> Request to Join
              </Button>
              <p className="text-sm text-gray-400 self-center">
                {pod.visibility === 'invite_only'
                  ? 'This pod is invite-only. Request to join or use an invite link.'
                  : pod.visibility === 'public_with_approval'
                  ? 'Your request will be reviewed by the pod director.'
                  : 'This is a private pod. Request access from the director.'}
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
          {(isDirectorOrHost || (isMember && pod?.allowMemberInvites)) && (
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
            <Button variant="secondary" onClick={() => setDuplicateOpen(true)}>
              <CopyPlus className="h-4 w-4 mr-2" /> Duplicate Pod
            </Button>
          )}
          {isDirector && (
            <Button
              variant="danger"
              onClick={() => {
                if (confirm('Archive this pod? Events will be preserved and you can reactivate later.')) {
                  deleteMutation.mutate();
                }
              }}
              isLoading={deleteMutation.isPending}
            >
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

      {/* ── Full Edit Modal ──────────────────────────────────────────────── */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Pod">
        <form
          onSubmit={e => { e.preventDefault(); updateMutation.mutate(editForm); }}
          className="space-y-4"
        >
          <Input
            label="Pod Name"
            value={editForm.name}
            onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
            required
          />

          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Description</label>
            <textarea
              className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
              rows={2}
              value={editForm.description}
              onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Pod Type</label>
              <select
                className={selectClass}
                value={editForm.podType}
                onChange={e => setEditForm(f => ({ ...f, podType: e.target.value }))}
              >
                {POD_TYPES_OPTIONS.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Visibility</label>
              <select
                className={selectClass}
                value={editForm.visibility}
                onChange={e => setEditForm(f => ({ ...f, visibility: e.target.value }))}
              >
                {VISIBILITY_OPTIONS.map(v => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Orchestration</label>
              <select
                className={selectClass}
                value={editForm.orchestrationMode}
                onChange={e => setEditForm(f => ({ ...f, orchestrationMode: e.target.value }))}
              >
                <option value="timed_rounds">Timed Rounds</option>
                <option value="free_form">Free Form</option>
                <option value="moderated">Moderated</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Communication</label>
              <select
                className={selectClass}
                value={editForm.communicationMode}
                onChange={e => setEditForm(f => ({ ...f, communicationMode: e.target.value }))}
              >
                <option value="video">Video</option>
                <option value="audio">Audio Only</option>
                <option value="text">Text</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Max Members (blank = unlimited)"
              type="number"
              value={editForm.maxMembers === '' ? '' : String(editForm.maxMembers)}
              onChange={e => setEditForm(f => ({ ...f, maxMembers: e.target.value === '' ? '' : Number(e.target.value) }))}
              placeholder="Unlimited"
            />
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-600 mb-1">Pod Rules (optional)</label>
              <textarea
                className="w-full rounded-lg bg-gray-100 border border-gray-200 px-3 py-2 text-gray-800 text-sm focus:border-[#1a1a2e] focus:ring-1 focus:ring-[#1a1a2e] outline-none"
                rows={2}
                placeholder="Community rules or guidelines shown to members"
                value={editForm.rules}
                onChange={e => setEditForm(f => ({ ...f, rules: e.target.value }))}
              />
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={editForm.allowMemberInvites}
              onChange={(e) => setEditForm(f => ({ ...f, allowMemberInvites: e.target.checked }))}
              className="h-4 w-4 rounded border-gray-300 text-[#1a1a2e] focus:ring-[#1a1a2e]"
            />
            <span className="text-sm text-gray-600">Allow members to invite others</span>
          </label>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={updateMutation.isPending}>Save Changes</Button>
          </div>
        </form>
      </Modal>

      {/* ── Duplicate Pod Modal (pre-filled CreatePodModal) ─────────────── */}
      <CreatePodModal
        open={duplicateOpen}
        onClose={() => setDuplicateOpen(false)}
        initialValues={duplicateInitialValues}
      />

      {/* ── Invite Members Modal ────────────────────────────────────────── */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite Members to Pod">
        <div className="space-y-5">
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
              <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                {/* Select All */}
                {(() => {
                  const invitable = podSearchResults.filter((u: any) => u.id !== user?.id && !activeMembers.some((m: any) => m.userId === u.id));
                  const allSelected = invitable.length > 0 && invitable.every((u: any) => podSelectedUsers.some(s => s.id === u.id));
                  return invitable.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (allSelected) {
                          const invitableIds = new Set(invitable.map((u: any) => u.id));
                          setPodSelectedUsers(prev => prev.filter(s => !invitableIds.has(s.id)));
                        } else {
                          const existing = new Set(podSelectedUsers.map(s => s.id));
                          const toAdd = invitable.filter((u: any) => !existing.has(u.id));
                          setPodSelectedUsers(prev => [...prev, ...toAdd]);
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
                {podSearchResults.filter((u: any) => u.id !== user?.id).map((u: any) => {
                  const alreadyMember = activeMembers.some((m: any) => m.userId === u.id);
                  const isSelected = !alreadyMember && podSelectedUsers.some(s => s.id === u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      disabled={alreadyMember}
                      onClick={() => !alreadyMember && setPodSelectedUsers(prev =>
                        isSelected ? prev.filter(s => s.id !== u.id) : [...prev, u]
                      )}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                        alreadyMember ? 'opacity-60 cursor-not-allowed bg-gray-50'
                        : isSelected ? 'bg-rsn-red-light hover:bg-rsn-red-100'
                        : 'hover:bg-gray-50'
                      }`}
                    >
                      {!alreadyMember && (
                        <div className={`h-4 w-4 rounded border ${isSelected ? 'bg-rsn-red border-rsn-red' : 'border-gray-300'} flex items-center justify-center shrink-0`}>
                          {isSelected && <Check className="h-3 w-3 text-white" />}
                        </div>
                      )}
                      <span className={`font-medium truncate ${alreadyMember ? 'text-gray-400' : 'text-gray-800'}`}>
                        {u.displayName || u.email}
                      </span>
                      {alreadyMember && (
                        <span className="ml-auto text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">
                          Already a member
                        </span>
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

          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[#1a1a2e]">Option 3 — Generate Shareable Link</h3>
            <p className="text-xs text-gray-500">Create a reusable link (up to 10 uses, expires in 7 days).</p>
            {!inviteLink ? (
              <Button variant="secondary" onClick={() => createInviteMutation.mutate({})} isLoading={createInviteMutation.isPending} className="w-full">
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
                <p className="text-xs text-gray-400">Ready to share. Up to 10 uses, expires in 7 days.</p>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* ── Pending Join Requests ───────────────────────────────────────── */}
      {isDirectorOrHost && pendingMembers.length > 0 && (
        <div className="animate-fade-in-up stagger-2">
          <h2 className="text-lg font-semibold text-amber-400 mb-3 flex items-center gap-2">
            <Clock className="h-5 w-5" /> Pending Requests ({pendingMembers.length})
          </h2>
          <div className="grid gap-2">
            {pendingMembers.map((m: any) => (
              <Card key={m.userId || m.id} className="!p-4 border-amber-500/20">
                <div className="flex items-center justify-between">
                  <a href={`/profile/${m.userId || m.id}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                    <Avatar src={m.avatarUrl} name={m.displayName || m.email || 'User'} size="sm" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{m.displayName || m.email || 'User'}</p>
                      <p className="text-xs text-amber-400">Pending approval</p>
                    </div>
                  </a>
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

      {/* ── Declined / No Response (director only) ──────────────────────── */}
      {isDirector && (declinedMembers.length > 0 || noResponseMembers.length > 0) && (
        <div className="animate-fade-in-up stagger-2">
          <h2 className="text-base font-semibold text-gray-400 mb-2 flex items-center gap-2">
            <XCircle className="h-4 w-4" /> Other Invite Outcomes
          </h2>
          <div className="grid gap-2">
            {declinedMembers.map((m: any) => (
              <Card key={m.userId || m.id} className="!p-3 bg-gray-50 border-gray-200">
                <a href={`/profile/${m.userId || m.id}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                  <Avatar src={m.avatarUrl} name={m.displayName || m.email || 'User'} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700">{m.displayName || m.email || 'User'}</p>
                    <p className="text-xs text-gray-400">Declined</p>
                  </div>
                </a>
              </Card>
            ))}
            {noResponseMembers.map((m: any) => (
              <Card key={m.userId || m.id} className="!p-3 bg-gray-50 border-gray-200">
                <a href={`/profile/${m.userId || m.id}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                  <Avatar src={m.avatarUrl} name={m.displayName || m.email || 'User'} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700">{m.displayName || m.email || 'User'}</p>
                    <p className="text-xs text-gray-400">No response</p>
                  </div>
                </a>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── Events ──────────────────────────────────────────────────────── */}
      {podSessions && podSessions.length > 0 && (
        <div className="animate-fade-in-up stagger-2">
          <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-rsn-red" /> Events ({podSessions.length})
          </h2>
          <div className="grid gap-2">
            {podSessions.map((s: any) => (
              <Card
                key={s.id}
                className="!p-4 cursor-pointer hover:border-gray-300 transition-colors"
                onClick={() => navigate(`/sessions/${s.id}`)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-[#1a1a2e]">{s.title || 'Untitled Event'}</p>
                    <p className="text-xs text-gray-400">
                      {s.scheduledAt ? formatDateTime(s.scheduledAt) : 'No date set'}
                    </p>
                  </div>
                  <Badge variant={s.status === 'scheduled' ? 'info' : s.status === 'active' ? 'success' : 'default'}>
                    {s.status}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── Join Rules Modal ───────────────────────────────────────────── */}
      <Modal open={showJoinRules} onClose={() => setShowJoinRules(false)} title="Pod Rules">
        <div className="space-y-4">
          {pod?.joinConfig?.rulesText && (
            <div className="rounded-xl bg-gray-50 p-4 text-sm text-gray-700 whitespace-pre-wrap">
              {pod.joinConfig.rulesText}
            </div>
          )}
          {pod?.joinConfig?.agreementText && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rulesAgreed}
                onChange={e => setRulesAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red"
              />
              <span className="text-sm text-gray-700">{pod.joinConfig.agreementText}</span>
            </label>
          )}
          {!pod?.joinConfig?.agreementText && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rulesAgreed}
                onChange={e => setRulesAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red"
              />
              <span className="text-sm text-gray-700">I have read and agree to the pod rules</span>
            </label>
          )}
          <Button
            disabled={!rulesAgreed}
            isLoading={requestJoinMutation.isPending}
            onClick={() => { requestJoinMutation.mutate(); setShowJoinRules(false); }}
            className="w-full"
          >
            Submit Request
          </Button>
        </div>
      </Modal>

      {/* ── Pending Pod Invites Banner (directors only) ─────────────────── */}
      {isDirectorOrHost && podMemberCounts?.pendingInvites > 0 && !showPodPendingInvites && (
        <Card className="animate-fade-in-up border-purple-200 bg-purple-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Send className="h-4 w-4 text-purple-600" />
              <p className="text-sm text-purple-800 font-medium">
                {podMemberCounts.pendingInvites} Pending Invite{podMemberCounts.pendingInvites > 1 ? 's' : ''}</p>
              <p className="text-xs text-purple-600">{podMemberCounts.pendingInvites} {podMemberCounts.pendingInvites > 1 ? "people haven't" : "person hasn't"} accepted their invite yet.</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setShowPodPendingInvites(true)} className="text-purple-700">
              <Eye className="h-4 w-4 mr-1" /> View & Remind
            </Button>
          </div>
        </Card>
      )}

      {/* ── Pending Pod Invites List ──────────────────────────────────────── */}
      {showPodPendingInvites && (
        <div className="animate-fade-in-up">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-[#1a1a2e] flex items-center gap-2">
              <Inbox className="h-5 w-5 text-purple-600" /> Pending Pod Invites ({podPendingInvites?.length ?? 0})
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setShowPodPendingInvites(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {!podPendingInvites || podPendingInvites.length === 0 ? (
            <Card><p className="text-gray-400 text-sm text-center py-3">No pending invites</p></Card>
          ) : (
            <div className="space-y-2">
              {podPendingInvites.filter((inv: any) => inv.inviteeEmail).length > 1 && (
                <div className="flex justify-end mb-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      podPendingInvites.filter((inv: any) => inv.inviteeEmail).forEach((inv: any) => {
                        api.post(`/invites/${inv.id}/remind`).catch(() => {});
                      });
                      addToast(`Reminders sent to ${podPendingInvites.filter((i: any) => i.inviteeEmail).length} pending invites`, 'success');
                    }}
                    className="!border-purple-300 !text-purple-700 hover:!bg-purple-100"
                  >
                    <Send className="h-3.5 w-3.5 mr-1" /> Remind All ({podPendingInvites.filter((i: any) => i.inviteeEmail).length})
                  </Button>
                </div>
              )}
              <div className="grid gap-2">
              {podPendingInvites.map((inv: any) => (
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
                          onClick={() => {
                            api.post(`/invites/${inv.id}/remind`).then(() => addToast('Reminder sent!', 'success')).catch(() => addToast('Failed to send reminder', 'error'));
                          }}
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

      {/* ── Members ────────────────────────────────────────────────────────── */}
      <div className="animate-fade-in-up stagger-2">
        <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-rsn-red" /> Members ({podMemberCounts?.total ?? activeMembers.length})
        </h2>

        {/* Status summary tabs (director/host only) */}
        {isDirectorOrHost && podMemberCounts && (
          <div className="flex flex-wrap gap-2 mb-3">
            {[
              { key: null, label: 'All', count: podMemberCounts.total, color: 'bg-gray-100 text-gray-700 border-gray-200' },
              ...(podMemberCounts.active > 0 ? [{ key: 'active', label: 'Active', count: podMemberCounts.active, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' }] : []),
              ...(podMemberCounts.pending_approval > 0 ? [{ key: 'pending_approval', label: 'Pending Approval', count: podMemberCounts.pending_approval, color: 'bg-amber-50 text-amber-700 border-amber-200' }] : []),
              ...(podMemberCounts.invited > 0 ? [{ key: 'invited', label: 'Invited', count: podMemberCounts.invited, color: 'bg-blue-50 text-blue-700 border-blue-200' }] : []),
              ...(podMemberCounts.declined > 0 ? [{ key: 'declined', label: 'Declined', count: podMemberCounts.declined, color: 'bg-red-50 text-red-600 border-red-200' }] : []),
              ...(podMemberCounts.left > 0 ? [{ key: 'left', label: 'Left', count: podMemberCounts.left, color: 'bg-gray-100 text-gray-500 border-gray-200' }] : []),
              ...(podMemberCounts.pendingInvites > 0 ? [{ key: 'pending_invite', label: 'Pending Invites', count: podMemberCounts.pendingInvites, color: 'bg-purple-50 text-purple-700 border-purple-200' }] : []),
            ].map((tab: any) => (
              <button
                key={tab.key ?? 'all'}
                onClick={() => {
                  if (tab.key === 'pending_invite') {
                    setShowPodPendingInvites(!showPodPendingInvites);
                    setMemberStatusFilter(null);
                  } else {
                    setShowPodPendingInvites(false);
                    setMemberStatusFilter(tab.key);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                  (tab.key === 'pending_invite' ? showPodPendingInvites : memberStatusFilter === tab.key)
                    ? 'ring-2 ring-rsn-red/30 border-rsn-red ' + tab.color
                    : tab.color + ' hover:opacity-80'
                }`}
              >
                <span>{tab.label}</span>
                <span className="font-bold">{tab.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="grid gap-2">
          {(memberStatusFilter === null ? activeMembers : membersList.filter((m: any) => m.status === memberStatusFilter)).map((m: any) => (
            <Card key={m.userId || m.id} className="!p-3">
              <div className="flex items-center justify-between">
                <a href={`/profile/${m.userId || m.id}`} className="flex-1 min-w-0 hover:opacity-80 transition-opacity">
                  <ProfileCard
                    compact
                    user={{
                      id: m.userId || m.id,
                      displayName: m.displayName || m.email || 'Member',
                      avatarUrl: m.avatarUrl,
                      jobTitle: m.jobTitle,
                      company: m.company,
                      interests: m.interests,
                    }}
                    badge={m.role === 'director' ? 'director' : m.role === 'host' ? 'host' : undefined}
                    badgeVariant={m.role === 'director' ? 'brand' : 'info'}
                  />
                </a>
                <div className="flex items-center gap-2 shrink-0">
                  {isDirector && m.userId !== user?.id && m.role !== 'director' && (
                    <button
                      onClick={() => changeRoleMutation.mutate({
                        userId: m.userId,
                        role: m.role === 'host' ? 'member' : 'host',
                      })}
                      className="px-2 py-1 rounded-lg text-xs font-medium text-rsn-red hover:bg-rsn-red-light border border-rsn-red-200 transition-all"
                      title={m.role === 'host' ? 'Demote to member' : 'Promote to host'}
                    >
                      {m.role === 'host' ? 'Demote' : 'Make Host'}
                    </button>
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
            <Card><p className="text-gray-400 text-sm text-center py-4">
              {isMember ? 'No members yet' : 'To access pod details, please join the pod.'}
            </p></Card>
          )}
        </div>
      </div>
    </div>
  );
}
