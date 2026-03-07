import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar, Users, Mail, Plus, Eye, ChevronRight } from 'lucide-react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';

export default function HomePage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const { data: pods, isLoading: podsLoading } = useQuery({
    queryKey: ['my-pods'],
    queryFn: () => api.get('/pods').then(r => r.data.data ?? []),
  });

  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get('/sessions').then(r => r.data.data ?? []),
  });

  const { data: invites, isLoading: invitesLoading } = useQuery({
    queryKey: ['my-invites'],
    queryFn: () => api.get('/invites').then(r => r.data.data ?? []),
  });

  if (podsLoading || sessionsLoading || invitesLoading) return <PageLoader />;

  const upcomingSessions = (sessions || []).filter((s: any) => s.status === 'scheduled');
  const acceptedInvites = (invites || []).filter((i: any) => i.status === 'accepted');
  const podCount = pods?.length || 0;

  // Unlock level logic (matching reference site)
  const unlockLevel = acceptedInvites.length >= 3 ? 'Pro' : acceptedInvites.length >= 1 ? 'Basic' : 'Starter';
  const unlockedPods = acceptedInvites.length >= 3 ? 3 : acceptedInvites.length >= 1 ? 1 : 0;

  // Getting started checklist
  const hasProfile = !!(user?.bio || user?.linkedinUrl);
  const hasInvite = (invites || []).length > 0;
  const hasPod = podCount > 0;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Welcome header */}
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-surface-100">
          Welcome, {user?.displayName || user?.firstName || 'there'}
        </h1>
        <p className="text-surface-400 mt-1">Here&apos;s what&apos;s happening with your RSN account.</p>
      </div>

      {/* Stats row — matching reference layout */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in-up">
        <Card className="cursor-pointer hover:border-surface-600 transition-colors" onClick={() => navigate('/pods')}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-surface-400">My Pods</p>
            <Users className="h-4 w-4 text-surface-500" />
          </div>
          <p className="text-3xl font-bold text-surface-100">{podCount}</p>
          <p className="text-xs text-surface-500 mt-1">Active pod memberships</p>
        </Card>

        <Card className="cursor-pointer hover:border-surface-600 transition-colors" onClick={() => navigate('/invites')}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-surface-400">Invites Sent</p>
            <Mail className="h-4 w-4 text-surface-500" />
          </div>
          <p className="text-3xl font-bold text-surface-100">{(invites || []).length}</p>
          <p className="text-xs text-surface-500 mt-1">{acceptedInvites.length} accepted</p>
        </Card>

        <Card className="cursor-pointer hover:border-surface-600 transition-colors" onClick={() => navigate('/sessions')}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-surface-400">Upcoming Events</p>
            <Calendar className="h-4 w-4 text-surface-500" />
          </div>
          <p className="text-3xl font-bold text-surface-100">{upcomingSessions.length}</p>
          <p className="text-xs text-surface-500 mt-1">Events registered</p>
        </Card>

        <Card className="border-brand-500/30 bg-brand-500/5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-surface-400">Unlock Level</p>
            <span className="text-xs font-medium text-brand-400">{unlockLevel}</span>
          </div>
          <p className="text-3xl font-bold text-surface-100">{unlockedPods} Pods</p>
          <p className="text-xs text-surface-500 mt-1">Unlocked capacity</p>
        </Card>
      </div>

      {/* Quick actions — matching reference 3-column layout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-fade-in-up">
        <Card className="flex flex-col">
          <h3 className="font-semibold text-surface-100 mb-1">Create a Pod</h3>
          <p className="text-sm text-surface-400 mb-4 flex-1">Start your own pod and invite members</p>
          <Button onClick={() => navigate('/pods')} className="w-full">
            <Plus className="h-4 w-4 mr-2" /> Create Pod
          </Button>
        </Card>

        <Card className="flex flex-col">
          <h3 className="font-semibold text-surface-100 mb-1">Invite Someone</h3>
          <p className="text-sm text-surface-400 mb-4 flex-1">Grow the network, unlock more features</p>
          <Button variant="secondary" onClick={() => navigate('/invites')} className="w-full">
            <Mail className="h-4 w-4 mr-2" /> Send Invite
          </Button>
        </Card>

        <Card className="flex flex-col">
          <h3 className="font-semibold text-surface-100 mb-1">Browse Events</h3>
          <p className="text-sm text-surface-400 mb-4 flex-1">Find upcoming networking events</p>
          <Button variant="secondary" onClick={() => navigate('/sessions')} className="w-full">
            <Eye className="h-4 w-4 mr-2" /> View Events
          </Button>
        </Card>
      </div>

      {/* Getting Started checklist — matching reference design */}
      <Card className="animate-fade-in-up">
        <h2 className="font-semibold text-surface-100 mb-1">Getting Started</h2>
        <p className="text-sm text-surface-400 mb-5">Complete these steps to get the most out of RSN</p>

        <div className="divide-y divide-surface-800">
          <button
            onClick={() => navigate('/profile')}
            className="flex items-center gap-4 w-full py-3 group hover:bg-surface-800/30 -mx-2 px-2 rounded-lg transition-colors"
          >
            <span className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${hasProfile ? 'bg-emerald-500/20 text-emerald-400' : 'bg-brand-500/20 text-brand-400'}`}>
              {hasProfile ? '✓' : '1'}
            </span>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-surface-200">Complete your profile</p>
              <p className="text-xs text-surface-500">Add your bio and LinkedIn</p>
            </div>
            <ChevronRight className="h-4 w-4 text-surface-600 group-hover:text-surface-400 transition-colors" />
          </button>

          <button
            onClick={() => navigate('/invites')}
            className="flex items-center gap-4 w-full py-3 group hover:bg-surface-800/30 -mx-2 px-2 rounded-lg transition-colors"
          >
            <span className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${hasInvite ? 'bg-emerald-500/20 text-emerald-400' : 'bg-brand-500/20 text-brand-400'}`}>
              {hasInvite ? '✓' : '2'}
            </span>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-surface-200">Invite someone great</p>
              <p className="text-xs text-surface-500">Unlock your first pod slot</p>
            </div>
            <ChevronRight className="h-4 w-4 text-surface-600 group-hover:text-surface-400 transition-colors" />
          </button>

          <button
            onClick={() => navigate('/pods')}
            className="flex items-center gap-4 w-full py-3 group hover:bg-surface-800/30 -mx-2 px-2 rounded-lg transition-colors"
          >
            <span className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${hasPod ? 'bg-emerald-500/20 text-emerald-400' : 'bg-brand-500/20 text-brand-400'}`}>
              {hasPod ? '✓' : '3'}
            </span>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-surface-200">Join or create a pod</p>
              <p className="text-xs text-surface-500">Start meeting with founders</p>
            </div>
            <ChevronRight className="h-4 w-4 text-surface-600 group-hover:text-surface-400 transition-colors" />
          </button>
        </div>
      </Card>
    </div>
  );
}
