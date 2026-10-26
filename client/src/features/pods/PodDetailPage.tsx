import { useState, type MouseEvent } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Users, Calendar, LogOut, Shield, UserMinus, Eye, Radio,
  Pencil, Trash2, UserPlus, Lock, Mail, UserCheck, X,
  Clock, CopyPlus, XCircle, AlertTriangle, MessagesSquare,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { sessionStatusLabel, sessionStatusColor } from '@/features/sessions/statusConfig';
import Avatar from '@/components/ui/Avatar';
import ProfileCard from '@/components/ui/ProfileCard';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { PageLoader, Skeleton } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { E } from '@/realtime/entities';
import { personHref } from '@/features/reason/human/profile-text';
import CreatePodModal from './CreatePodModal';
import EditPodModal from './EditPodModal';
import PodWall from './PodWall';
import { orchestrationLabel, podStatusLabel } from './pod-header-text';
import { podEventsInOrder } from './pod-event-order';
import { isForbidden, retryUnlessAnswered } from '@/components/wall/wall-logic';
import InvitePickerSheet from '@/features/invites/InvitePickerSheet';
import InviteStatusList from '@/features/invites/InviteStatusList';

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

/** What the page lists of each of the pod's events. */
interface PodEventRow {
  id: string;
  title: string | null;
  scheduledAt: string | null;
  status: string;
}

// The sections a phone's chip row jumps to; the ids are on the sections below.
const SECTIONS = [
  { id: 'pod-discussion', label: 'Discussion' },
  { id: 'pod-events', label: 'Events' },
  { id: 'pod-members', label: 'Members' },
] as const;

// ─── Component ───────────────────────────────────────────────────────────────

export default function PodDetailPage() {
  const { podId } = useParams();
  const navigate = useNavigate();
  // ?post=<id>: a bell about the pod's wall, or a shared address, lands on one post and the wall scrolls to it.
  const [searchParams] = useSearchParams();
  const highlightPostId = searchParams.get('post') || undefined;
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();

  // Edit Pod is its own sheet (EditPodModal, 26 Oct 2026): a react-hook-form form that follows the pod type.
  const [editOpen, setEditOpen] = useState(false);

  // "Invite members": the invite sheet (features/invites, 26 Oct 2026), the people chosen from your connections.
  const [inviteOpen, setInviteOpen] = useState(false);

  const [memberStatusFilter, setMemberStatusFilter] = useState<string | null>(null);
  // Duplicate pod: open CreatePodModal pre-filled
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  // Request to join: rules agreement
  const [showJoinRules, setShowJoinRules] = useState(false);
  const [rulesAgreed, setRulesAgreed] = useState(false);

  const { data: pod, isLoading, error: podError } = useQuery({
    queryKey: ['pod', podId],
    queryFn: () => api.get(`/pods/${podId}`).then(r => r.data.data),
    retry: (failureCount, err: any) => {
      // Don't retry 404s — pod is private or doesn't exist
      if (err?.response?.status === 404) return false;
      return failureCount < 3;
    },
    meta: { entities: podId ? [E.pod(podId)] : [] },
  });

  const { data: members } = useQuery({
    queryKey: ['pod-members', podId],
    queryFn: () => api.get(`/pods/${podId}/members`).then(r => r.data.data ?? []),
    enabled: !!podId,
    meta: { entities: podId ? [E.pod(podId), E.podMembers(podId)] : [] },
  });

  const { data: sessionCountData } = useQuery({
    queryKey: ['pod-session-count', podId],
    queryFn: () => api.get(`/pods/${podId}/session-count`).then(r => r.data.data?.count ?? 0),
    enabled: !!podId,
    meta: { entities: podId ? [E.pod(podId), E.podSessions(podId)] : [] },
  });

  // The server lists a pod's events to its active members (the only ones it names a role for) and to admins, and
  // answers 403 to anyone else, so nobody else asks.
  const mayReadEvents = !!pod?.memberRole || user?.role === 'admin' || user?.role === 'super_admin';
  const {
    data: podSessions, isError: sessionsFailed, error: sessionsError, refetch: refetchSessions,
  } = useQuery({
    queryKey: ['pod-sessions', podId],
    queryFn: () => api.get(`/sessions?podId=${podId}`).then(r => (r.data.data ?? []) as PodEventRow[]),
    enabled: !!podId && mayReadEvents,
    retry: retryUnlessAnswered,
    meta: { entities: podId ? [E.pod(podId), E.podSessions(podId)] : [] },
  });
  // Refused all the same: this page's copy of the pod still named a role the member has just lost.
  const eventsRefused = isForbidden(sessionsError);

  const { data: podMemberCounts } = useQuery({
    queryKey: ['pod-member-counts', podId],
    queryFn: () => api.get(`/pods/${podId}/member-counts`).then(r => r.data.data),
    enabled: !!podId,
    meta: { entities: podId ? [E.pod(podId), E.podMembers(podId)] : [] },
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
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ['pod', podId] });
      qc.invalidateQueries({ queryKey: ['pod-members', podId] });
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      // T1-3 (Issue 3) — if this pod has a live or imminent session,
      // navigate the user straight into it. Removes the "joined a pod
      // but the event isn't visible" frustration. Falls through to a
      // toast when there's nothing live (user stays on pod page).
      try {
        const res = await api.get(`/pods/${podId}/active-session`);
        const session = res?.data?.data?.session;
        if (session?.id) {
          addToast('Joined pod — taking you to the event', 'success');
          // Imminent (scheduled but not started) → session detail page;
          // live (lobby_open, round_*, closing_lobby) → live lobby.
          const liveStatuses = ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'];
          if (liveStatuses.includes(session.status)) {
            navigate(`/session/${session.id}/live`);
          } else {
            navigate(`/sessions/${session.id}`);
          }
          return;
        }
      } catch {
        // Non-fatal — fall through to default toast
      }
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

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const openEdit = () => setEditOpen(true);

  // The wall found the pod closed before this page's own copy said so (the archive route tells the pod's screens a
  // moment before it saves the new status): read the pod again, so the badge, the buttons and the wall agree.
  const refreshPod = () => { void qc.invalidateQueries({ queryKey: ['pod', podId], exact: true }); };

  // A chip scrolls its section into view. A plain address with #section would add a history entry and leave <main>,
  // the page's scroll area, where it is.
  const jumpTo = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ─── Render guards ─────────────────────────────────────────────────────────

  if (isLoading) return <PageLoader />;

  // 404 — pod is private (hidden from non-members) or genuinely doesn't exist.
  // Don't leak which: show a unified access-denied card.
  if ((podError as any)?.response?.status === 404) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <button onClick={() => navigate('/pods')} className="flex min-h-[44px] items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Pods
        </button>
        <Card className="animate-fade-in-up">
          <div className="flex flex-col items-center text-center py-10 px-4">
            <div className="h-14 w-14 rounded-full bg-amber-100 flex items-center justify-center mb-4">
              <AlertTriangle className="h-7 w-7 text-amber-600" />
            </div>
            <h1 className="text-xl font-bold text-[#1a1a2e] mb-2">Pod not found</h1>
            <p className="text-gray-500 text-sm max-w-md">
              This pod doesn't exist or you don't have access to view it.
            </p>
            <Button variant="primary" onClick={() => navigate('/pods')} className="mt-6">
              Back to Pods
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!pod) return <p className="text-gray-500 text-center py-20">Pod not found</p>;

  const membersList    = members || pod.members || [];
  const activeMembers  = membersList.filter((m: any) => m.status === 'active');
  const pendingMembers = membersList.filter((m: any) => m.status === 'pending_approval');
  const declinedMembers  = membersList.filter((m: any) => m.status === 'declined');
  const noResponseMembers = membersList.filter((m: any) => m.status === 'no_response');

  // Stefan (2 Jul) — pending requesters aren't members yet. They live in
  // the Pending Requests section only, so every count in the Members
  // section excludes them (the duplicate "Pending Approval" chip is gone).
  // 26 Oct 2026: pending invites are not members either. The server's total counts them, and they are listed by the
  // Invitations card now, not among the members, so they are taken out of this count too.
  const memberTotal = podMemberCounts
    ? podMemberCounts.total - (podMemberCounts.pending_approval || 0) - (podMemberCounts.pendingInvites || 0)
    : pod.memberCount ?? activeMembers.length;

  const myMembership     = membersList.find((m: any) => m.userId === user?.id);
  const isAdminUser      = user?.role === 'admin' || user?.role === 'super_admin';
  const isMember         = myMembership?.status === 'active' || !!pod.memberRole || isAdminUser;
  // An active member of the pod. The server names a member role only for an active member.
  const isActiveMember   = myMembership?.status === 'active' || !!pod.memberRole;
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
    <div className="max-w-3xl mx-auto space-y-6 lg:max-w-6xl">
      <button onClick={() => navigate('/pods')} className="flex min-h-[44px] items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Pods
      </button>

      {/* Pod Header */}
      <Card className="animate-fade-in-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a2e]">{pod.name}</h1>
            <p className="text-gray-500 mt-1">{pod.description || 'No description'}</p>
          </div>
          <Badge variant={pod.status === 'active' ? 'success' : 'default'}>{podStatusLabel(pod.status)}</Badge>
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

        {/* How the pod's events run, in plain words and read through the pod's type (an old Reason pod saved on timed
            rounds says Freeform). This printed the stored column, "timed rounds", and a communication mode that
            nothing reads and the forms no longer ask for. */}
        <div className="flex gap-2 mt-3">
          <Badge variant="brand">{orchestrationLabel(pod)}</Badge>
        </div>
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
            <Button variant="secondary" onClick={() => setInviteOpen(true)}>
              <Mail className="h-4 w-4 mr-2" /> Invite members
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
      <EditPodModal open={editOpen} onClose={() => setEditOpen(false)} pod={pod} />

      {/* ── Duplicate Pod Modal (pre-filled CreatePodModal) ─────────────── */}
      <CreatePodModal
        open={duplicateOpen}
        onClose={() => setDuplicateOpen(false)}
        initialValues={duplicateInitialValues}
      />

      {/* ── Invite members: the invite sheet (your connections, by email, a link) ─────── */}
      {podId && (
        <InvitePickerSheet
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          target={{ type: 'pod', podId }}
          podName={pod.name}
          linkCap={pod.maxMembers}
        />
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

      {/* ── Circles this pod belongs to (REASON P3b) ────────────────────── */}
      <PodCircleChips podId={podId} />

      {/* ── Jump to a section (phone and tablet; from 1024px the sections sit side by side) ── */}
      <nav aria-label="Jump to a section" className="flex flex-wrap gap-2 lg:hidden">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => jumpTo(e, s.id)}
            className="inline-flex min-h-[44px] items-center rounded-full border border-gray-200 bg-white px-4 text-sm font-medium text-[#1a1a2e] transition-colors hover:bg-gray-50"
          >
            {s.label}
          </a>
        ))}
      </nav>

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
                  <Link to={personHref(m.userId || m.id, 'Pods')} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                    <Avatar src={m.avatarUrl} name={m.displayName || m.email || 'User'} size="sm" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{m.displayName || m.email || 'User'}</p>
                      <p className="text-xs text-amber-400">Pending approval</p>
                    </div>
                  </Link>
                  <div className="flex items-center gap-2">
                    <button onClick={() => approveMutation.mutate(m.userId)} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-all" title="Approve" aria-label="Approve">
                      <UserCheck className="h-4 w-4" />
                    </button>
                    <button onClick={() => rejectMutation.mutate(m.userId)} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-red-400 hover:bg-red-500/10 transition-all" title="Reject" aria-label="Reject">
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
                <Link to={personHref(m.userId || m.id, 'Pods')} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                  <Avatar src={m.avatarUrl} name={m.displayName || m.email || 'User'} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700">{m.displayName || m.email || 'User'}</p>
                    <p className="text-xs text-gray-400">Declined</p>
                  </div>
                </Link>
              </Card>
            ))}
            {noResponseMembers.map((m: any) => (
              <Card key={m.userId || m.id} className="!p-3 bg-gray-50 border-gray-200">
                <Link to={personHref(m.userId || m.id, 'Pods')} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                  <Avatar src={m.avatarUrl} name={m.displayName || m.email || 'User'} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700">{m.displayName || m.email || 'User'}</p>
                    <p className="text-xs text-gray-400">No response</p>
                  </div>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── Discussion beside Events and Members ────────────────────────── */}
      {/* One column on a phone and a tablet (Discussion, Events, Members, in that order); from 1024px two: the
          discussion on the left, the pod's events and members beside it. min-w-0 on both columns, because a
          grid column does not shrink below its content and one long unbroken word would widen the page. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <section id="pod-discussion" className="min-w-0 scroll-mt-4">
          <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
            <MessagesSquare className="h-5 w-5 text-rsn-red" /> Discussion
          </h2>
          {podId && (
            <PodWall
              podId={podId}
              podStatus={pod.status}
              isMember={isMember}
              isActiveMember={isActiveMember}
              highlightPostId={highlightPostId}
              onPodStatusStale={refreshPod}
            />
          )}
        </section>

        <div className="min-w-0 space-y-6">
          {/* ── Events ──────────────────────────────────────────────────── */}
          <section id="pod-events" className="scroll-mt-4 animate-fade-in-up stagger-2">
            <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
              <Calendar className="h-5 w-5 text-rsn-red" /> Events{podSessions ? ` (${podSessions.length})` : ''}
            </h2>
            {!mayReadEvents || eventsRefused ? (
              <Card className="!p-4">
                <p className="text-center text-sm text-gray-500">Members see the pod's events here.</p>
              </Card>
            ) : sessionsFailed && !podSessions ? (
              <Card className="!p-4 text-center">
                <p className="text-sm text-gray-600">We could not load the events just now.</p>
                <Button variant="ghost" onClick={() => void refetchSessions()} className="mx-auto mt-2 min-h-[44px]">Try again</Button>
              </Card>
            ) : !podSessions ? (
              <Skeleton className="h-16" />
            ) : podSessions.length > 0 ? (
              <div className="grid grid-cols-1 gap-2">
                {podEventsInOrder(podSessions).map((s) => (
                  <Card
                    key={s.id}
                    className="!p-4 cursor-pointer hover:border-gray-300 transition-colors"
                    onClick={() => navigate(`/sessions/${s.id}`)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-[#1a1a2e]">{s.title || 'Untitled Event'}</p>
                        <p className="text-xs text-gray-400">
                          {s.scheduledAt ? formatDateTime(s.scheduledAt) : 'No date set'}
                        </p>
                      </div>
                      {/* This showed the raw column value, so a member read
                          "round_transition" here (21 Sep 2026). One helper names
                          every state in plain words now. 'active' was never a
                          real status, so the old colour test never matched. */}
                      <Badge variant={sessionStatusColor(s.status)} className="shrink-0">
                        {sessionStatusLabel(s.status)}
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="!p-4">
                <p className="text-center text-sm text-gray-400">No events yet.</p>
              </Card>
            )}
          </section>

          {/* ── Members ──────────────────────────────────────────────────── */}
          <section id="pod-members" className="scroll-mt-4 animate-fade-in-up stagger-2">
            <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
              <Users className="h-5 w-5 text-rsn-red" /> Members ({memberTotal})
            </h2>

            {/* Status summary tabs (director/host only) */}
            {isDirectorOrHost && podMemberCounts && (
              <div className="flex flex-wrap gap-2 mb-3">
                {[
                  { key: null, label: 'All', count: memberTotal, color: 'bg-gray-100 text-gray-700 border-gray-200' },
                  ...(podMemberCounts.active > 0 ? [{ key: 'active', label: 'Active', count: podMemberCounts.active, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' }] : []),
                  ...(podMemberCounts.invited > 0 ? [{ key: 'invited', label: 'Invited', count: podMemberCounts.invited, color: 'bg-blue-50 text-blue-700 border-blue-200' }] : []),
                  ...(podMemberCounts.declined > 0 ? [{ key: 'declined', label: 'Declined', count: podMemberCounts.declined, color: 'bg-red-50 text-red-600 border-red-200' }] : []),
                  ...(podMemberCounts.left > 0 ? [{ key: 'left', label: 'Left', count: podMemberCounts.left, color: 'bg-gray-100 text-gray-500 border-gray-200' }] : []),
                ].map((tab: any) => (
                  <button
                    key={tab.key ?? 'all'}
                    onClick={() => setMemberStatusFilter(tab.key)}
                    className={`flex min-h-[44px] items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                      memberStatusFilter === tab.key
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

            {/* grid-cols-1, not an auto track: an auto track grows to the longest truncated job title
                in it, and the page then scrolls sideways on a phone. */}
            <div className="grid grid-cols-1 gap-2">
              {(memberStatusFilter === null ? activeMembers : membersList.filter((m: any) => m.status === memberStatusFilter)).map((m: any) => (
                <Card key={m.userId || m.id} className="!p-3">
                  {/* A director's two controls take the row from the name in the 320px column: they wrap under it. */}
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <Link to={personHref(m.userId || m.id, 'Pods')} className="min-w-0 flex-[1_1_14rem] hover:opacity-80 transition-opacity">
                      <ProfileCard
                        compact
                        user={{
                          id: m.userId || m.id,
                          displayName: m.displayName || 'Member',
                          avatarUrl: m.avatarUrl,
                          jobTitle: m.jobTitle,
                          company: m.company,
                        }}
                        badge={m.role === 'director' ? 'director' : m.role === 'host' ? 'host' : undefined}
                        badgeVariant={m.role === 'director' ? 'brand' : 'info'}
                      />
                    </Link>
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      {isDirector && m.userId !== user?.id && m.role !== 'director' && (
                        <button
                          onClick={() => changeRoleMutation.mutate({
                            userId: m.userId,
                            role: m.role === 'host' ? 'member' : 'host',
                          })}
                          className="min-h-[44px] px-2 py-1 rounded-lg text-xs font-medium text-rsn-red hover:bg-rsn-red-light border border-rsn-red-200 transition-all"
                          title={m.role === 'host' ? 'Demote to member' : 'Promote to host'}
                        >
                          {m.role === 'host' ? 'Demote' : 'Make Host'}
                        </button>
                      )}
                      {isDirector && m.userId !== user?.id && (
                        <button
                          onClick={() => removeMemberMutation.mutate(m.userId)}
                          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
                          title="Remove member"
                          aria-label="Remove member"
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
          </section>

          {/* ── Invitations: who is invited, who declined (the pod's director, host and admins), for any pod that is not
               archived: a draft or suspended pod can be invited to (the button above shows; the server refuses only an
               archived pod), so its organisers see the card too. ─────── */}
          {isDirectorOrHost && pod.status !== 'archived' && podId && (
            <InviteStatusList
              target={{ type: 'pod', podId }}
              present={activeMembers.map((m: { userId: string }) => m.userId)}
              presentCount={activeMembers.length}
              onInvite={() => setInviteOpen(true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── REASON P3b — circles this pod is attached to (chips) ────────────────────
function PodCircleChips({ podId }: { podId?: string }) {
  // realtime: skip — attachment changes are rare admin actions; refetches on visit
  const { data: circles } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['circlesOfPod', podId],
    queryFn: () => api.get(`/circles/of-pod/${podId}`).then(r => r.data.data ?? []),
    enabled: !!podId,
  });
  if (!circles || circles.length === 0) return null;
  return (
    <div className="animate-fade-in-up">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-gray-500">In circles:</span>
        {circles.map(c => (
          <a
            key={c.id} href={`/circles/${c.id}`}
            className="text-xs font-medium text-rsn-red bg-rsn-red-light px-2.5 py-1 rounded-full hover:opacity-80 transition-opacity min-h-[28px] inline-flex items-center"
          >{c.name}</a>
        ))}
      </div>
    </div>
  );
}
