import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar, Users, Mail, Plus, Eye, ChevronRight, Inbox } from 'lucide-react';
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

  const { data: receivedInvites } = useQuery({
    queryKey: ['received-invites'],
    queryFn: () => api.get('/invites/received').then(r => r.data.data ?? []),
  });

  if (podsLoading || sessionsLoading || invitesLoading) return <PageLoader />;

  const activePods = (pods || []).filter((p: any) => p.status === 'active');
  const upcomingSessions = (sessions || []).filter((s: any) => s.status === 'scheduled');
  const totalAccepted = (invites || []).reduce((sum: number, i: any) => sum + (i.useCount || 0), 0);
  const podCount = activePods.length;

  // Unlock level logic (matching reference site)
  const unlockLevel = totalAccepted >= 3 ? 'Pro' : totalAccepted >= 1 ? 'Basic' : 'Starter';

  // Getting started checklist
  const hasProfile = !!(user?.bio || user?.linkedinUrl);
  const hasInvite = (invites || []).length > 0;
  const hasPod = podCount > 0;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
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

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in-up">
        <Card className="cursor-pointer hover:border-gray-300 transition-colors" onClick={() => navigate('/pods')}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-500">My Pods</p>
            <Users className="h-4 w-4 text-gray-400" />
          </div>
          <p className="text-3xl font-bold text-[#1a1a2e]">{podCount}</p>
          <p className="text-xs text-gray-400 mt-1">Active pod memberships</p>
        </Card>

        <Card className="cursor-pointer hover:border-gray-300 transition-colors" onClick={() => navigate('/invites')}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-500">Invites Created</p>
            <Mail className="h-4 w-4 text-gray-400" />
          </div>
          <p className="text-3xl font-bold text-[#1a1a2e]">{(invites || []).length}</p>
          <p className="text-xs text-gray-400 mt-1">{totalAccepted} accepted</p>
        </Card>

        <Card className="cursor-pointer hover:border-gray-300 transition-colors" onClick={() => navigate('/sessions')}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-500">Upcoming Events</p>
            <Calendar className="h-4 w-4 text-gray-400" />
          </div>
          <p className="text-3xl font-bold text-[#1a1a2e]">{upcomingSessions.length}</p>
          <p className="text-xs text-gray-400 mt-1">Events registered</p>
        </Card>

        <Card className="border-rsn-red-200 bg-rsn-red-light/50">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-500">Unlock Level</p>
            <span className="text-xs font-medium text-rsn-red">{unlockLevel}</span>
          </div>
          <p className="text-3xl font-bold text-[#1a1a2e]">{totalAccepted}/{unlockLevel === 'Starter' ? 1 : unlockLevel === 'Basic' ? 3 : '∞'}</p>
          <p className="text-xs text-gray-400 mt-1">Accepted invites{unlockLevel === 'Starter' ? ' — invite 1 to unlock' : ''}</p>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-fade-in-up">
        <Card className="flex flex-col">
          <h3 className="font-semibold text-[#1a1a2e] mb-1">Create a Pod</h3>
          <p className="text-sm text-gray-500 mb-4 flex-1">Start your own pod and invite members</p>
          <Button onClick={() => navigate('/pods')} className="w-full">
            <Plus className="h-4 w-4 mr-2" /> Create Pod
          </Button>
        </Card>

        <Card className="flex flex-col">
          <h3 className="font-semibold text-[#1a1a2e] mb-1">Invite Someone</h3>
          <p className="text-sm text-gray-500 mb-4 flex-1">Grow the network, unlock more features</p>
          <Button variant="secondary" onClick={() => navigate('/invites')} className="w-full">
            <Mail className="h-4 w-4 mr-2" /> Send Invite
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
