import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Eye, ChevronRight, Inbox } from 'lucide-react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import OnboardingWelcomeModal from '@/features/onboarding/OnboardingWelcomeModal';

// 13 Aug meeting: the dashboard now leads with Suggestions, Pods, Circles,
// Messages, each tile owning its own action rather than a separate row of
// buttons with no obvious owner. Shared shape for all four headline tiles.
function Tile({ id, label, value, hint, to, action }: {
  id: string; label: string; value: number; hint: string; to: string; action: string;
}) {
  return (
    <Card className="flex flex-col justify-between !p-4" data-testid={`tile-${id}`}>
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="mt-0.5 text-2xl font-bold text-[#1a1a2e]">{value}</p>
        <p className="mt-0.5 text-xs text-gray-400">{hint}</p>
      </div>
      <Link
        to={to}
        className="mt-3 flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 text-sm font-medium text-[#1a1a2e] hover:bg-gray-50"
      >
        {action}
      </Link>
    </Card>
  );
}

export default function HomePage() {
  const { user } = useAuthStore();
  const currentUserId = user?.id;
  const navigate = useNavigate();

  const { data: pods, isLoading: podsLoading } = useQuery({
    queryKey: ['my-pods'],
    queryFn: () => api.get('/pods').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.userPods(currentUserId)] : [] },
  });

  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get('/sessions').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.userSessions(currentUserId)] : [] },
  });

  const { data: invites, isLoading: invitesLoading } = useQuery({
    queryKey: ['my-invites'],
    queryFn: () => api.get('/invites').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.userInvites(currentUserId)] : [] },
  });

  const { data: receivedInvites } = useQuery({
    queryKey: ['received-invites'],
    queryFn: () => api.get('/invites/received').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.userInvites(currentUserId)] : [] },
  });

  // Shares its cache entry with AppLayout's nav badge and AgentsPage's default
  // (non-archived) list — same key, same meta, intentional sharing.
  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents', false],
    queryFn: () => api.get('/agents').then(r => r.data.data as Array<{ matchCount: number }>),
    meta: { entities: currentUserId ? [E.user(currentUserId)] : [] },
  });

  // Deliberately NOT the ['circles'] key AppLayout uses for nav visibility —
  // that query is intentionally untagged (`// realtime: skip`, nav-only). A
  // query's `meta` lives on the shared Query object, not per-observer, so
  // whichever observer fetches last wins the `meta` for the whole cache
  // entry; sharing the key here would make this tile's realtime updates
  // flicker on/off depending on fetch order between the two components.
  const { data: circles, isLoading: circlesLoading } = useQuery({
    queryKey: ['circles', 'dashboard-count'],
    queryFn: () => api.get('/circles').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.user(currentUserId)] : [] },
  });

  // Shares its cache entry with ChatQuickAccess and MessagesPage — both
  // already use this exact key with this exact meta shape.
  const { data: conversations, isLoading: conversationsLoading } = useQuery({
    queryKey: ['dm-conversations'],
    queryFn: () => api.get('/dm/conversations').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.userDms(currentUserId)] : [] },
  });

  // The four headline tiles load together — a tile flipping from 0 to a real
  // number after the page already looks "done" is worse than a slightly
  // longer initial loader, and all three new queries are cheap list reads
  // like the ones already gated below.
  if (podsLoading || sessionsLoading || invitesLoading || agentsLoading || circlesLoading || conversationsLoading) {
    return <PageLoader />;
  }

  const activePods = (pods || []).filter((p: any) => p.status === 'active');
  const upcomingSessions = (sessions || []).filter((s: any) => s.status === 'scheduled');
  const totalAccepted = (invites || []).reduce((sum: number, i: any) => sum + (i.useCount || 0), 0);
  const podCount = activePods.length;
  const upcomingCount = upcomingSessions.length;
  const inviteCount = (invites || []).length;

  const suggestionCount = (agents ?? []).reduce((n, a) => n + (a.matchCount || 0), 0);
  // listCircles returns every circle platform-wide with an isMember flag
  // (it's the browse list AppLayout uses to decide nav visibility) — the
  // tile says "you're part of", so it counts memberships, not the total.
  const circleCount = (circles ?? []).filter((c: any) => c.isMember).length;
  const unreadCount = (conversations ?? []).filter((c: any) => c.unreadCount > 0).length;

  // Unlock level logic (matching reference site)
  const unlockLevel = totalAccepted >= 3 ? 'Pro' : totalAccepted >= 1 ? 'Basic' : 'Starter';

  // Getting started checklist
  const hasProfile = !!(user?.bio || user?.linkedinUrl);
  const hasInvite = (invites || []).length > 0;
  const hasPod = podCount > 0;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <OnboardingWelcomeModal />
      {/* Welcome header */}
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">
          Welcome, {user?.displayName || user?.firstName || 'there'}
        </h1>
        <p className="text-gray-500 mt-1">Here&apos;s what&apos;s happening with your RSN account.</p>
      </div>

      {/* Pending received invites banner */}
      {receivedInvites && receivedInvites.length > 0 && (
        <button
          onClick={() => navigate('/invites')}
          className="w-full flex items-center gap-3 p-4 rounded-xl border border-rsn-red-200 bg-rsn-red-light hover:bg-rsn-red-100 transition-colors animate-fade-in-up"
        >
          <Inbox className="h-5 w-5 text-rsn-red shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-sm font-semibold text-[#1a1a2e]">
              You have {receivedInvites.length} pending invite{receivedInvites.length > 1 ? 's' : ''}
            </p>
            <p className="text-xs text-gray-500">Click to view and accept pod/event invitations sent to you.</p>
          </div>
          <ChevronRight className="h-4 w-4 text-rsn-red/60" />
        </button>
      )}

      {/* Headline tiles: Suggestions, Pods, Circles, Messages — each owns its
          own action (13 Aug meeting), replacing the old stat-cards-plus-
          separate-buttons layout. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 animate-fade-in-up">
        <Tile id="suggestions" label="Suggestions" value={suggestionCount}
              hint="people your agents found" to="/agents" action="View suggestions" />
        <Tile id="pods" label="Pods" value={podCount}
              hint="you belong to" to="/pods" action="Create a pod" />
        <Tile id="circles" label="Circles" value={circleCount}
              hint="you're part of" to="/circles" action="Browse circles" />
        <Tile id="messages" label="Messages" value={unreadCount}
              hint="unread conversations" to="/messages" action="Open messages" />
      </div>

      {/* Second row: an agenda rather than headline metrics, per Claus's
          note — events will grow varied (circle events, 1:1s), so this is a
          list, not a counter. Unlock Level rides along here too: it's driven
          by the same invites data and isn't part of the new headline row. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 animate-fade-in-up">
        <Card className="!p-4" data-testid="tile-events">
          <p className="text-sm font-semibold text-[#1a1a2e]">Your agenda</p>
          <p className="mt-0.5 text-xs text-gray-400">
            {upcomingCount === 0 ? 'Nothing scheduled yet' : `${upcomingCount} coming up`}
          </p>
          <Link to="/sessions" className="mt-3 flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 text-sm font-medium hover:bg-gray-50">
            View events
          </Link>
        </Card>
        <Card className="!p-4" data-testid="tile-invites">
          <p className="text-sm font-semibold text-[#1a1a2e]">Invites</p>
          <p className="mt-0.5 text-xs text-gray-400">{inviteCount} sent</p>
          <Link to="/invites" className="mt-3 flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 text-sm font-medium hover:bg-gray-50">
            Invite someone
          </Link>
        </Card>
        <Card className="!p-4 border-rsn-red-200 bg-rsn-red-light/50" data-testid="tile-unlock">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-[#1a1a2e]">Unlock Level</p>
            <span className="text-xs font-medium text-rsn-red">{unlockLevel}</span>
          </div>
          <p className="mt-0.5 text-xs text-gray-400">
            {totalAccepted}/{unlockLevel === 'Starter' ? 1 : unlockLevel === 'Basic' ? 3 : '∞'} accepted invites
            {unlockLevel === 'Starter' ? ' — invite 1 to unlock' : ''}
          </p>
          <Link to="/invites" className="mt-3 flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 text-sm font-medium hover:bg-gray-50">
            Invite someone
          </Link>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-fade-in-up">
        <Card className="flex flex-col">
          <h3 className="font-semibold text-[#1a1a2e] mb-1">Create a Pod</h3>
          <p className="text-sm text-gray-500 mb-4 flex-1">Start your own pod and invite members</p>
          <Button onClick={() => navigate('/pods?create=true')} className="w-full">
            <Plus className="h-4 w-4 mr-2" /> Create Pod
          </Button>
        </Card>

        <Card className="flex flex-col">
          <h3 className="font-semibold text-[#1a1a2e] mb-1">Browse Events</h3>
          <p className="text-sm text-gray-500 mb-4 flex-1">Find upcoming networking events</p>
          <Button variant="secondary" onClick={() => navigate('/sessions')} className="w-full">
            <Eye className="h-4 w-4 mr-2" /> View Events
          </Button>
        </Card>
      </div>

      {/* Getting Started checklist */}
      <Card className="animate-fade-in-up">
        <h2 className="font-semibold text-[#1a1a2e] mb-1">Getting Started</h2>
        <p className="text-sm text-gray-500 mb-5">Complete these steps to get the most out of RSN</p>

        <div className="divide-y divide-gray-100">
          <button
            onClick={() => navigate('/profile')}
            className="flex items-center gap-4 w-full py-3 group hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors"
          >
            <span className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${hasProfile ? 'bg-emerald-50 text-emerald-600' : 'bg-rsn-red-light text-rsn-red'}`}>
              {hasProfile ? '✓' : '1'}
            </span>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-gray-800">Complete your profile</p>
              <p className="text-xs text-gray-400">Add your bio and LinkedIn</p>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
          </button>

          <button
            onClick={() => navigate('/invites')}
            className="flex items-center gap-4 w-full py-3 group hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors"
          >
            <span className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${hasInvite ? 'bg-emerald-50 text-emerald-600' : 'bg-rsn-red-light text-rsn-red'}`}>
              {hasInvite ? '✓' : '2'}
            </span>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-gray-800">Invite someone great</p>
              <p className="text-xs text-gray-400">Unlock your first pod slot</p>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
          </button>

          <button
            onClick={() => navigate('/pods')}
            className="flex items-center gap-4 w-full py-3 group hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors"
          >
            <span className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${hasPod ? 'bg-emerald-50 text-emerald-600' : 'bg-rsn-red-light text-rsn-red'}`}>
              {hasPod ? '✓' : '3'}
            </span>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-gray-800">Join or create a pod</p>
              <p className="text-xs text-gray-400">Start meeting with founders</p>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
          </button>
        </div>
      </Card>
    </div>
  );
}
