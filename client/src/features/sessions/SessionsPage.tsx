import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar, Plus, Mic } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';

export default function SessionsPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { data, isLoading } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get('/sessions').then(r => r.data.data ?? []),
  });

  if (isLoading) return <PageLoader />;

  const statusVariant = (s: string) => {
    if (s === 'scheduled') return 'info';
    if (s === 'active' || s === 'in_progress') return 'success';
    if (s === 'completed') return 'default';
    return 'warning';
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Events</h1>
        <Button onClick={() => navigate('/sessions/new')} className="btn-glow"><Plus className="h-4 w-4 mr-2" /> New Event</Button>
      </div>

      {(!data || data.length === 0) ? (
        <EmptyState
          icon={<Calendar className="h-8 w-8" />}
          title="No events yet"
          description="Schedule an event to start connecting."
          action={<Button onClick={() => navigate('/sessions/new')}>Schedule Event</Button>}
        />
      ) : (
        <div className="grid gap-4 animate-fade-in-up">
          {data.map((s: any) => {
            const isHost = s.hostUserId === user?.id;
            return (
              <Card key={s.id} hover onClick={() => navigate(`/sessions/${s.id}`)} className="card-hover">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-gray-800">
                        {s.title || 'Open event'}
                      </p>
                      {isHost && (
                        <Badge variant="brand" className="text-xs">
                          <Mic className="h-3 w-3 mr-1" /> Hosting
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {s.scheduledAt ? new Date(s.scheduledAt).toLocaleString() : 'No date'}
                      {s.podName && <span className="ml-2 text-gray-400">· {s.podName}</span>}
                      {s.hostDisplayName && !isHost && (
                        <span className="ml-2 text-gray-400">· Host: {s.hostDisplayName}</span>
                      )}
                    </p>
                  </div>
                  <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
