import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Calendar, Plus } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';

export default function SessionsPage() {
  const navigate = useNavigate();
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-surface-100">Sessions</h1>
        <Button onClick={() => navigate('/sessions/new')}><Plus className="h-4 w-4 mr-2" /> New Session</Button>
      </div>

      {(!data || data.length === 0) ? (
        <EmptyState
          icon={<Calendar className="h-8 w-8" />}
          title="No sessions yet"
          description="Schedule a session to start connecting."
          action={<Button onClick={() => navigate('/sessions/new')}>Schedule Session</Button>}
        />
      ) : (
        <div className="grid gap-4">
          {data.map((s: any) => (
            <Card key={s.id} hover onClick={() => navigate(`/sessions/${s.id}`)}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-surface-200">
                    {s.scheduledAt ? new Date(s.scheduledAt).toLocaleString() : 'No date'}
                  </p>
                  <p className="text-sm text-surface-400">{s.title || 'Open session'}</p>
                </div>
                <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
