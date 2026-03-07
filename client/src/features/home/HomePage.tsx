import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar, Users, ArrowRight, Sparkles } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
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

  if (podsLoading || sessionsLoading) return <PageLoader />;

  const upcomingSessions = (sessions || []).filter((s: any) => s.status === 'scheduled').slice(0, 3);

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Welcome */}
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-surface-100">
            Welcome{user?.displayName ? `, ${user.displayName}` : ''}
          </h1>
          <p className="text-surface-400 mt-1">Here&apos;s your networking overview</p>
        </div>
        <Sparkles className="h-8 w-8 text-brand-400 animate-pulse-slow" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'My Pods', value: pods?.length || 0, icon: Users },
          { label: 'Sessions', value: sessions?.length || 0, icon: Calendar },
          { label: 'Upcoming', value: upcomingSessions.length, icon: ArrowRight },
        ].map((s, i) => (
          <Card key={s.label} className={`flex items-center gap-4 animate-fade-in-up stagger-${i + 1}`}>
            <div className="h-12 w-12 rounded-xl bg-brand-500/20 flex items-center justify-center group-hover:scale-110 transition-transform">
              <s.icon className="h-6 w-6 text-brand-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-surface-100">{s.value}</p>
              <p className="text-sm text-surface-400">{s.label}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Upcoming Sessions */}
      <div className="animate-fade-in-up stagger-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-surface-100">Upcoming Sessions</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('/sessions')}>View all <ArrowRight className="h-4 w-4 ml-1" /></Button>
        </div>
        {upcomingSessions.length === 0 ? (
          <Card className="text-center py-8">
            <p className="text-surface-400">No upcoming sessions</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate('/sessions/new')}>Schedule one</Button>
          </Card>
        ) : (
          <div className="grid gap-3">
            {upcomingSessions.map((s: any) => (
              <Card key={s.id} hover onClick={() => navigate(`/sessions/${s.id}`)}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-surface-200">{new Date(s.scheduledAt).toLocaleDateString()}</p>
                    <p className="text-sm text-surface-400">{s.title || 'Open session'}</p>
                  </div>
                  <Badge variant="brand">{s.status}</Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* My Pods */}
      <div className="animate-fade-in-up stagger-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-surface-100">My Pods</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('/pods')}>View all <ArrowRight className="h-4 w-4 ml-1" /></Button>
        </div>
        {(pods || []).length === 0 ? (
          <Card className="text-center py-8">
            <p className="text-surface-400">You&apos;re not in any pods yet</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate('/pods')}>Browse pods</Button>
          </Card>
        ) : (
          <div className="grid gap-3">
            {(pods || []).slice(0, 3).map((p: any) => (
              <Card key={p.id} hover onClick={() => navigate(`/pods/${p.id}`)}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-surface-200">{p.name}</p>
                    <p className="text-sm text-surface-400">{p.memberCount || 0} members</p>
                  </div>
                  <Badge>{p.status}</Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
