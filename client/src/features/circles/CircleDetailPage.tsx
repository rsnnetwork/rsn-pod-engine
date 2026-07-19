// ─── Circle Detail ───────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). A circle's home: who's in it, which pods
// are attached, upcoming events those pods run, nested child circles. The
// wall lands here in Phase 4.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Users, Calendar, Box, CircleDashed } from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';

interface CircleDetail {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  isMember: boolean;
  members: Array<{ userId: string; displayName: string | null; avatarUrl: string | null; role: string }>;
  pods: Array<{ podId: string; name: string; description: string | null }>;
  upcomingEvents: Array<{ id: string; title: string; scheduledAt: string; podId: string }>;
  children: Array<{ id: string; name: string; memberCount: number }>;
}

export default function CircleDetailPage() {
  const { circleId } = useParams();
  const { addToast } = useToastStore();
  const queryClient = useQueryClient();

  const { data: circle, isLoading } = useQuery<CircleDetail>({
    queryKey: ['circle', circleId],
    queryFn: () => api.get(`/circles/${circleId}`).then(r => r.data.data),
    enabled: !!circleId,
  });

  const joinLeave = async () => {
    if (!circle) return;
    try {
      await api.post(`/circles/${circle.id}/${circle.isMember ? 'leave' : 'join'}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['circle', circleId] }),
        queryClient.invalidateQueries({ queryKey: ['circles'] }),
      ]);
      addToast(circle.isMember ? `Left ${circle.name}` : `Welcome to ${circle.name}!`, 'success');
    } catch {
      addToast('That didn\'t work — try again.', 'error');
    }
  };

  if (isLoading || !circle) return <PageLoader />;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link to="/circles" className="inline-flex items-center gap-1.5 min-h-[44px] text-sm text-gray-500 hover:text-gray-800 transition-colors animate-fade-in">
        <ArrowLeft className="h-4 w-4" /> All circles
      </Link>

      <div className="flex items-start justify-between gap-3 animate-fade-in">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1a1a2e]">{circle.name}</h1>
          {circle.description && <p className="text-gray-500 text-sm mt-1">{circle.description}</p>}
          <p className="flex items-center gap-1.5 text-xs text-gray-400 mt-2">
            <Users className="h-3.5 w-3.5" /> {circle.memberCount} {circle.memberCount === 1 ? 'member' : 'members'}
          </p>
        </div>
        <Button
          variant={circle.isMember ? 'ghost' : 'primary'}
          onClick={joinLeave}
          className="min-h-[44px] shrink-0"
        >
          {circle.isMember ? 'Leave' : 'Join circle'}
        </Button>
      </div>

      {circle.children.length > 0 && (
        <div className="space-y-2 animate-fade-in-up">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <CircleDashed className="h-4 w-4 text-rsn-red" /> Circles inside
          </h2>
          <div className="grid gap-2">
            {circle.children.map(ch => (
              <Card key={ch.id} className="card-hover !p-4">
                <Link to={`/circles/${ch.id}`} className="flex items-center justify-between min-h-[36px]">
                  <p className="font-medium text-gray-900">{ch.name}</p>
                  <p className="text-xs text-gray-400">{ch.memberCount} members</p>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      )}

      {circle.upcomingEvents.length > 0 && (
        <div className="space-y-2 animate-fade-in-up">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-rsn-red" /> Upcoming events
          </h2>
          <div className="grid gap-2">
            {circle.upcomingEvents.map(e => (
              <Card key={e.id} className="card-hover !p-4">
                <Link to={`/sessions/${e.id}`} className="flex items-center justify-between gap-2 min-h-[36px]">
                  <p className="font-medium text-gray-900 truncate">{e.title}</p>
                  <p className="text-xs text-gray-400 whitespace-nowrap">
                    {new Date(e.scheduledAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      )}

      {circle.pods.length > 0 && (
        <div className="space-y-2 animate-fade-in-up">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <Box className="h-4 w-4 text-rsn-red" /> Pods in this circle
          </h2>
          <div className="grid gap-2">
            {circle.pods.map(p => (
              <Card key={p.podId} className="card-hover !p-4">
                <Link to={`/pods/${p.podId}`} className="block min-h-[36px]">
                  <p className="font-medium text-gray-900">{p.name}</p>
                  {p.description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{p.description}</p>}
                </Link>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 animate-fade-in-up">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Users className="h-4 w-4 text-rsn-red" /> Members
        </h2>
        {circle.members.length === 0 ? (
          <Card><p className="text-sm text-gray-500 text-center py-2">Nobody here yet — be the first to join.</p></Card>
        ) : (
          <div className="grid gap-2">
            {circle.members.map(m => (
              <Card key={m.userId} className="!p-3">
                <Link to={`/profile/${m.userId}`} className="flex items-center gap-3 min-h-[36px] hover:opacity-80 transition-opacity">
                  <Avatar src={m.avatarUrl || undefined} name={m.displayName || 'User'} size="sm" />
                  <p className="text-sm font-medium text-gray-900 truncate">{m.displayName || 'Member'}</p>
                  {m.role === 'moderator' && (
                    <span className="ml-auto text-[10px] font-semibold text-rsn-red bg-rsn-red-light px-2 py-0.5 rounded-full">MOD</span>
                  )}
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
