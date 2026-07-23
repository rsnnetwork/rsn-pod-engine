import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Shield, ArrowLeft, RefreshCw, ChevronDown, ChevronRight, Linkedin,
  Paperclip, ShieldAlert,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';
import { E } from '@/realtime/entities';

// ─── Task E3: admin per-user inspector ───────────────────────────────────────
//
// "Usable, not elegant" (product owner's words) — four tabs over the E2 admin
// read API, plus one write action (refresh-enrichment). Every query is fetched
// eagerly on mount (not gated by the active tab) so switching tabs is purely
// conditional rendering over already-fetched/cached data — no dangling
// requests, no race conditions from a fast tab flip. The one query that IS
// gated (the selected conversation's messages) is keyed by conversationId, so
// clicking between threads quickly never cross-contaminates — react-query
// just serves each key's own cache slot.
//
// All member-authored content (transcript, messages, report reasons) renders
// as plain React children — never dangerouslySetInnerHTML.

type TabKey = 'onboarding' | 'profile' | 'conversations' | 'reports';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'profile', label: 'Profile & Matching' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'reports', label: 'Reports & Interactions' },
];

const ENRICHMENT_BADGE: Record<string, 'default' | 'success' | 'info' | 'warning' | 'danger' | 'brand'> = {
  none: 'default',
  searching: 'info',
  found: 'success',
  partial: 'warning',
  not_found: 'default',
  failed: 'danger',
};

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtDurationMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDurationBetween(startIso: string | null | undefined, endIso: string | null | undefined): string {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 0) return '—';
  return fmtDurationMs(ms);
}

export default function AdminUserInspectorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const admin = isAdmin(user?.role);

  const [tab, setTab] = useState<TabKey>('onboarding');
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);

  // React Router reuses this same component instance when only the :id param
  // changes (no remount) — without this, navigating directly from one
  // inspector URL to another would carry over a stale selected conversation
  // (and tab) that belongs to the PREVIOUS subject. Reset on every subject
  // change so each inspector view always starts clean.
  useEffect(() => {
    setSelectedConvId(null);
    setTab('onboarding');
    refreshMutation.reset();
  }, [id]);

  // Admin-only E2 diagnostic endpoint — no realtime entity is emitted for it
  // server-side. Kept fresh via refetchInterval while a refresh is actually
  // running; otherwise a manual tab revisit/reload is the intended refresh.
  // realtime: skip — admin-only diagnostic read, no server-side entity emitted
  const onboardingQuery = useQuery({
    queryKey: ['admin-inspect-onboarding', id],
    queryFn: () => api.get(`/admin/users/${id}/onboarding`).then((r) => r.data.data),
    enabled: admin && !!id,
    // Keep polling while a refresh is actually running so the UI reflects the
    // eventual terminal state without the admin having to manually refetch.
    refetchInterval: (q: any) => (q.state.data?.enrichment?.status === 'searching' ? 3000 : false),
  });

  // Same endpoint PublicProfilePage uses — reuse its existing entity tag.
  const profileQuery = useQuery({
    queryKey: ['admin-inspect-profile', id],
    queryFn: () => api.get(`/users/${id}`).then((r) => r.data.data),
    enabled: admin && !!id,
    meta: { entities: id ? [E.user(id)] : [] },
  });

  // Admin-only E2 diagnostic endpoint — no realtime entity emitted server-side.
  // realtime: skip — admin-only diagnostic read, no server-side entity emitted
  const conversationsQuery = useQuery({
    queryKey: ['admin-inspect-conversations', id],
    queryFn: () => api.get(`/admin/users/${id}/conversations`).then((r) => r.data.data),
    enabled: admin && !!id,
  });

  // Admin-only E2 diagnostic endpoint — no realtime entity emitted server-side.
  // realtime: skip — admin-only diagnostic read, no server-side entity emitted
  const interactionsQuery = useQuery({
    queryKey: ['admin-inspect-interactions', id],
    queryFn: () => api.get(`/admin/users/${id}/interactions`).then((r) => r.data.data),
    enabled: admin && !!id,
  });

  // This DM read is deliberately audited server-side on every fetch (INSERT
  // INTO audit_log before the messages are returned) — auto-invalidating on
  // realtime activity would create audit rows the admin never actually asked
  // for. Re-clicking the thread is the intended refresh.
  // realtime: skip — audited-on-every-read endpoint, no auto-invalidation
  const messagesQuery = useQuery({
    queryKey: ['admin-inspect-messages', selectedConvId],
    queryFn: () => api.get(`/admin/conversations/${selectedConvId}/messages`).then((r) => r.data.data),
    enabled: admin && !!selectedConvId,
  });

  const refreshMutation = useMutation({
    mutationFn: (targetId: string) => api.post('/onboarding/admin/refresh-enrichment', { userId: targetId }),
    onSuccess: (_data, targetId) => {
      addToast('Re-enrichment started for this member', 'success');
      qc.invalidateQueries({ queryKey: ['admin-inspect-onboarding', targetId] });
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Failed to start re-enrichment', 'error');
    },
  });

  if (!admin) {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <Shield className="h-16 w-16 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Admin Only</h2>
        <p className="text-gray-500 mb-4">This page is restricted to administrators.</p>
        <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  const targetUser = profileQuery.data;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 animate-fade-in">
        <div className="min-w-0">
          <button
            onClick={() => navigate('/admin/users')}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-2 min-h-[44px]"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Users
          </button>
          <div className="flex items-center gap-3">
            <Avatar src={targetUser?.avatarUrl} name={targetUser?.displayName || 'User'} size="md" />
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-[#1a1a2e] truncate">{targetUser?.displayName || 'User Inspector'}</h1>
              <p className="text-gray-500 text-xs truncate">{targetUser?.email}</p>
            </div>
          </div>
        </div>
        <Shield className="h-8 w-8 text-rsn-red shrink-0" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto bg-gray-100 rounded-xl p-1 animate-fade-in">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`shrink-0 min-h-[44px] px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium whitespace-nowrap transition-all duration-200 ${
              tab === t.key ? 'bg-white text-[#1a1a2e] shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'onboarding' && (
        <OnboardingTab
          key={id}
          data={onboardingQuery.data}
          isLoading={onboardingQuery.isLoading}
          isError={onboardingQuery.isError}
          onRefresh={() => {
            if (confirm('Force a re-enrichment for this member? This clears their cached LinkedIn lookup and re-runs it in the background.')) {
              refreshMutation.mutate(id!);
            }
          }}
          refreshing={refreshMutation.isPending}
        />
      )}

      {tab === 'profile' && (
        <ProfileTab
          user={targetUser}
          isLoading={profileQuery.isLoading}
          isError={profileQuery.isError}
          intent={onboardingQuery.data?.intent}
        />
      )}

      {tab === 'conversations' && (
        <ConversationsTab
          conversations={conversationsQuery.data}
          isLoading={conversationsQuery.isLoading}
          isError={conversationsQuery.isError}
          targetUserId={id!}
          selectedConvId={selectedConvId}
          onSelect={setSelectedConvId}
          messages={messagesQuery.data}
          messagesLoading={messagesQuery.isFetching}
        />
      )}

      {tab === 'reports' && (
        <ReportsTab
          data={interactionsQuery.data}
          isLoading={interactionsQuery.isLoading}
          isError={interactionsQuery.isError}
          targetUserId={id!}
        />
      )}
    </div>
  );
}

// ─── Onboarding tab ───────────────────────────────────────────────────────────

function OnboardingTab({ data, isLoading, isError, onRefresh, refreshing }: {
  data: any; isLoading: boolean; isError: boolean; onRefresh: () => void; refreshing: boolean;
}) {
  if (isLoading) return <PageLoader />;
  if (isError || !data) {
    return <Card><p className="text-sm text-red-500 text-center py-6">Failed to load onboarding data.</p></Card>;
  }

  const enrichment = data.enrichment ?? {};
  const conversation: Array<{ role: string; content: string }> = data.conversation ?? [];
  const stageEvents: Array<{ id: string; stage: string; detail: Record<string, unknown>; durationMs: number | null; createdAt: string }> =
    data.stageEvents ?? [];

  return (
    <div className="space-y-4 animate-fade-in-up">
      {/* Status + refresh */}
      <Card className="!p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <div>
              <span className="text-gray-400 text-xs uppercase tracking-wide block">Status</span>
              <Badge variant="brand">{data.onboardingStatus}</Badge>
            </div>
            <div>
              <span className="text-gray-400 text-xs uppercase tracking-wide block">Last onboarded</span>
              <span className="text-gray-700">{fmtDateTime(data.lastOnboardedAt)}</span>
            </div>
            <div>
              <span className="text-gray-400 text-xs uppercase tracking-wide block">LinkedIn</span>
              {data.linkedinUrl ? (
                <a
                  href={data.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                >
                  <Linkedin className="h-3.5 w-3.5" /> Open profile
                </a>
              ) : (
                <span className="italic text-gray-300">Not set</span>
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onRefresh}
            disabled={refreshing}
            isLoading={refreshing}
            className="shrink-0 min-h-[44px]"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh enrichment
          </Button>
        </div>
      </Card>

      {/* Enrichment block */}
      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Enrichment</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <Field label="Status"><Badge variant={ENRICHMENT_BADGE[enrichment.status] ?? 'default'}>{enrichment.status ?? 'none'}</Badge></Field>
          <Field label="Source">{enrichment.source || '—'}</Field>
          <Field label="Started">{fmtDateTime(enrichment.startedAt)}</Field>
          <Field label="Completed">{fmtDateTime(enrichment.completedAt)}</Field>
          <Field label="Duration">{fmtDurationBetween(enrichment.startedAt, enrichment.completedAt)}</Field>
        </div>
        {enrichment.error && (
          <p className="mt-3 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 break-words">{enrichment.error}</p>
        )}
      </Card>

      {/* Stage-event timeline */}
      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Stage timeline</h3>
        {stageEvents.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No stage events recorded.</p>
        ) : (
          <div className="space-y-0">
            {stageEvents.map((se) => (
              <div key={se.id} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3 text-xs border-b border-gray-100 py-2 last:border-0">
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="default">{se.stage}</Badge>
                  <span className="text-gray-400">{timeAgo(se.createdAt)}</span>
                  {se.durationMs != null && <span className="text-gray-400">· {fmtDurationMs(se.durationMs)}</span>}
                </div>
                {se.detail && Object.keys(se.detail).length > 0 && (
                  <code className="block sm:flex-1 min-w-0 break-all bg-gray-50 rounded px-1.5 py-0.5 text-[11px] text-gray-500">
                    {JSON.stringify(se.detail)}
                  </code>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Transcript */}
      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Transcript</h3>
        {conversation.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No transcript recorded.</p>
        ) : (
          <div className="flex flex-col gap-3 max-h-[420px] overflow-y-auto rounded-xl bg-gray-50 p-3 sm:p-4">
            {conversation.map((m, i) =>
              m.role === 'assistant' ? (
                <p key={i} className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md border border-gray-200 bg-white px-4 py-2.5 text-sm leading-relaxed text-[#1a1a2e] shadow-sm">
                  {m.content}
                </p>
              ) : (
                <p key={i} className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-rsn-red px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
                  {m.content}
                </p>
              ),
            )}
          </div>
        )}
      </Card>

      {/* Structured intent — collapsible pretty JSON */}
      <CollapsibleJson label="Structured intent (raw)" value={data.intent} />
    </div>
  );
}

// ─── Profile & Matching tab ──────────────────────────────────────────────────

function ProfileTab({ user, isLoading, isError, intent }: { user: any; isLoading: boolean; isError: boolean; intent: any }) {
  if (isLoading) return <PageLoader />;
  if (isError || !user) {
    return <Card><p className="text-sm text-red-500 text-center py-6">Failed to load profile.</p></Card>;
  }

  return (
    <div className="space-y-4 animate-fade-in-up">
      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Account</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <Field label="Role"><Badge variant="brand">{user.role}</Badge></Field>
          <Field label="Status"><Badge variant={user.status === 'active' ? 'success' : 'warning'}>{user.status}</Badge></Field>
          <Field label="Profile complete">{user.profileComplete ? 'Yes' : 'No'}</Field>
          <Field label="Email verified">{user.emailVerified ? 'Yes' : 'No'}</Field>
          <Field label="Created">{fmtDateTime(user.createdAt)}</Field>
          <Field label="Last active">{fmtDateTime(user.lastActiveAt)}</Field>
        </div>
      </Card>

      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Profile</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mb-4">
          <Field label="Company">{user.company || '—'}</Field>
          <Field label="Job title">{user.jobTitle || '—'}</Field>
          <Field label="Industry">{user.industry || '—'}</Field>
          <Field label="Location">{user.location || '—'}</Field>
          <Field label="Languages">{user.languages?.length ? user.languages.join(', ') : '—'}</Field>
          <Field label="Timezone">{user.timezone || '—'}</Field>
        </div>
        <Field label="Bio">{user.bio || '—'}</Field>
      </Card>

      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Matching profile</h3>
        <div className="space-y-3 text-sm">
          <Field label="What I care about">{user.whatICareAbout || '—'}</Field>
          <Field label="What I can help with">{user.whatICanHelpWith || '—'}</Field>
          <Field label="Who I want to meet">{user.whoIWantToMeet || '—'}</Field>
          <Field label="Why I want to meet">{user.whyIWantToMeet || '—'}</Field>
          <Field label="My intent">{user.myIntent || '—'}</Field>
        </div>
        <div className="mt-4">
          <ChipList label="Interests" items={user.interests} />
        </div>
        <div className="mt-3">
          <ChipList label="Reasons to connect" items={user.reasonsToConnect} />
        </div>
      </Card>

      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Onboarding intent (extracted)</h3>
        <div className="text-sm mb-3">
          <span className="text-gray-400 text-xs uppercase tracking-wide block mb-1">Profile strength</span>
          {intent?.profileStrength ? <Badge variant={intent.profileStrength === 'strong' ? 'success' : 'warning'}>{intent.profileStrength}</Badge> : <span className="text-gray-400">—</span>}
        </div>
        <ChipList label="Matching tags" items={intent?.tags} />
        <div className="mt-3">
          <ChipList label="Avoid preferences" items={intent?.avoidPreferences} variant="danger" />
        </div>
      </Card>
    </div>
  );
}

function ChipList({ label, items, variant = 'default' }: { label: string; items?: string[]; variant?: 'default' | 'danger' }) {
  return (
    <div>
      <span className="text-gray-400 text-xs uppercase tracking-wide block mb-1.5">{label}</span>
      {items && items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((t) => (
            <span
              key={t}
              className={`px-2.5 py-1 text-xs rounded-full ${variant === 'danger' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}
            >
              {t}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-sm italic text-gray-300">None</span>
      )}
    </div>
  );
}

// ─── Conversations tab ───────────────────────────────────────────────────────

function ConversationsTab({ conversations, isLoading, isError, targetUserId, selectedConvId, onSelect, messages, messagesLoading }: {
  conversations: any[] | undefined; isLoading: boolean; isError: boolean; targetUserId: string;
  selectedConvId: string | null; onSelect: (id: string) => void;
  messages: any[] | undefined; messagesLoading: boolean;
}) {
  const selected = conversations?.find((c) => c.conversationId === selectedConvId);

  return (
    <div className="space-y-4 animate-fade-in-up">
      <div className="flex items-center gap-2 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        Access is audit logged.
      </div>

      {isLoading ? <PageLoader /> : isError ? (
        <Card><p className="text-sm text-red-500 text-center py-6">Failed to load conversations.</p></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
          <div className="space-y-2">
            {(!conversations || conversations.length === 0) && (
              <Card><p className="text-sm text-gray-400 text-center py-6">No conversations</p></Card>
            )}
            {conversations?.map((c) => (
              <button
                key={c.conversationId}
                onClick={() => onSelect(c.conversationId)}
                className={`w-full text-left rounded-xl border p-3 min-h-[44px] transition-colors ${
                  selectedConvId === c.conversationId ? 'border-rsn-red bg-rsn-red-light' : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Avatar src={c.partner?.avatarUrl} name={c.partner?.displayName || 'User'} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-800 truncate">{c.partner?.displayName || 'Unknown user'}</p>
                    <p className="text-xs text-gray-400">{c.messageCount} messages · {timeAgo(c.lastMessageAt)}</p>
                  </div>
                  {c.deletedAt && <Badge variant="warning">deleted</Badge>}
                </div>
                {c.meetingConfirmedWindow && (
                  <p className="mt-1.5 text-[11px] text-gray-400">Meeting window: {c.meetingConfirmedWindow}</p>
                )}
              </button>
            ))}
          </div>

          <Card className="!p-5">
            {!selectedConvId ? (
              <p className="text-sm text-gray-400 text-center py-6">Select a conversation to view its messages.</p>
            ) : messagesLoading ? (
              <PageLoader />
            ) : (
              <div className="flex flex-col gap-3 max-h-[480px] overflow-y-auto">
                {(!messages || messages.length === 0) && (
                  <p className="text-sm text-gray-400 text-center py-6">No messages in this thread.</p>
                )}
                {messages?.map((m) => {
                  const isTarget = m.fromUserId === targetUserId;
                  const senderLabel = isTarget ? 'This member' : (selected?.partner?.displayName || 'Partner');
                  return (
                    <div key={m.id} className={`max-w-[85%] ${isTarget ? 'self-end items-end' : 'self-start items-start'} flex flex-col gap-0.5`}>
                      <span className="text-[11px] text-gray-400">{senderLabel} · {fmtDateTime(m.createdAt)}</span>
                      <p className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                        isTarget ? 'rounded-br-md bg-rsn-red text-white' : 'rounded-bl-md border border-gray-200 bg-white text-[#1a1a2e]'
                      }`}>
                        {m.content || <span className="italic opacity-70">[attachment only]</span>}
                      </p>
                      {m.attachmentUrl && (
                        <a
                          href={m.attachmentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
                        >
                          <Paperclip className="h-3 w-3" /> Attachment
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── Reports & Interactions tab ──────────────────────────────────────────────

function ReportsTab({ data, isLoading, isError, targetUserId }: { data: any; isLoading: boolean; isError: boolean; targetUserId: string }) {
  if (isLoading) return <PageLoader />;
  if (isError || !data) {
    return <Card><p className="text-sm text-red-500 text-center py-6">Failed to load interactions.</p></Card>;
  }

  const reports: any[] = data.reports ?? [];
  const pokesSent: any[] = data.pokesSent ?? [];
  const pokesReceived: any[] = data.pokesReceived ?? [];
  const blocksGiven: any[] = data.blocks?.given ?? [];
  const blocksReceived: any[] = data.blocks?.received ?? [];

  return (
    <div className="space-y-4 animate-fade-in-up">
      <Card className="!p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Reports</h3>
        {reports.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No reports involving this user.</p>
        ) : (
          <div className="space-y-2">
            {reports.map((r) => {
              const filedByTarget = r.reporterId === targetUserId;
              return (
                <div key={r.id} className="flex flex-col sm:flex-row sm:items-center gap-2 border-b border-gray-100 pb-2 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="default">{r.source}</Badge>
                    <Badge variant={r.status === 'resolved' || r.status === 'actioned' ? 'success' : r.status === 'dismissed' ? 'default' : 'warning'}>
                      {r.status}
                    </Badge>
                    <Badge variant={filedByTarget ? 'info' : 'brand'}>
                      {filedByTarget ? 'Filed by this member' : 'Filed against this member'}
                    </Badge>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-700">{r.reason}</div>
                    {r.detailText && (
                      <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap break-words">{r.detailText}</p>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 shrink-0">{fmtDateTime(r.createdAt)}</div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="!p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Pokes sent (initiated by this member)</h3>
          {pokesSent.length === 0 ? (
            <p className="text-sm text-gray-400 italic">None</p>
          ) : (
            <div className="space-y-2">
              {pokesSent.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 text-sm border-b border-gray-100 pb-2 last:border-0">
                  <span className="truncate">{p.otherUser?.displayName || 'Unknown'}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={p.status === 'accepted' ? 'success' : p.status === 'declined' ? 'danger' : 'default'}>{p.status}</Badge>
                    <span className="text-xs text-gray-400">{timeAgo(p.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="!p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Pokes received (initiated by others)</h3>
          {pokesReceived.length === 0 ? (
            <p className="text-sm text-gray-400 italic">None</p>
          ) : (
            <div className="space-y-2">
              {pokesReceived.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 text-sm border-b border-gray-100 pb-2 last:border-0">
                  <span className="truncate">{p.otherUser?.displayName || 'Unknown'}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={p.status === 'accepted' ? 'success' : p.status === 'declined' ? 'danger' : 'default'}>{p.status}</Badge>
                    <span className="text-xs text-gray-400">{timeAgo(p.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="!p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Blocked by this member</h3>
          {blocksGiven.length === 0 ? (
            <p className="text-sm text-gray-400 italic">None</p>
          ) : (
            <div className="space-y-2">
              {blocksGiven.map((b: any) => (
                <div key={b.blockedId} className="text-sm border-b border-gray-100 pb-2 last:border-0">
                  <span className="font-medium text-gray-700">{b.displayName || 'Unknown'}</span>
                  <span className="text-xs text-gray-400 ml-2">{timeAgo(b.createdAt)}</span>
                  {b.reason && <p className="text-xs text-gray-400 mt-0.5">{b.reason}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="!p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Blocked this member</h3>
          {blocksReceived.length === 0 ? (
            <p className="text-sm text-gray-400 italic">None</p>
          ) : (
            <div className="space-y-2">
              {blocksReceived.map((b: any) => (
                <div key={b.blockerId} className="text-sm border-b border-gray-100 pb-2 last:border-0">
                  <span className="font-medium text-gray-700">{b.displayName || 'Unknown'}</span>
                  <span className="text-xs text-gray-400 ml-2">{timeAgo(b.createdAt)}</span>
                  {b.reason && <p className="text-xs text-gray-400 mt-0.5">{b.reason}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Shared small components ─────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-0.5">{label}</p>
      <div className="text-gray-700 break-words">{children}</div>
    </div>
  );
}

function CollapsibleJson({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 min-h-[44px] text-left text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        {label}
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all border-t border-gray-200 bg-white px-4 py-3 text-xs text-gray-600">
          {JSON.stringify(value ?? {}, null, 2)}
        </pre>
      )}
    </div>
  );
}
