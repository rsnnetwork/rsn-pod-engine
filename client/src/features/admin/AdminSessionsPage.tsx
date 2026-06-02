import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, Trash2, XCircle } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin, formatDateTime } from '@/lib/utils';
import api from '@/lib/api';
import { sessionStatusLabel, sessionStatusColor } from '@/features/sessions/statusConfig';

export default function AdminSessionsPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-sessions', filter],
    queryFn: () => api.get(`/sessions?pageSize=100&admin=true${filter !== 'all' ? `&status=${filter}` : ''}`).then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
  });

  const cancelMutation = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/sessions/${sessionId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-sessions'] }); addToast('Event cancelled', 'success'); },
    onError: () => addToast('Failed to cancel event', 'error'),
  });

  const hardDeleteMutation = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/sessions/${sessionId}/permanent`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-sessions'] }); addToast('Event permanently deleted', 'success'); },
    onError: () => addToast('Failed to delete event', 'error'),
  });

  if (isLoading) return <PageLoader />;

  const isSuperAdmin = user?.role === 'super_admin';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Manage Events</h1>
        <Calendar className="h-6 w-6 text-rsn-red" />
      </div>

      <div className="flex gap-2 flex-wrap">
        {['all', 'scheduled', 'completed', 'cancelled'].map(f => (
          <Button
            key={f}
            variant={filter === f ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 animate-fade-in-up">
        {(!data || data.length === 0) ? (
          <Card className="text-center py-8">
            <p className="text-gray-500">No events found</p>
          </Card>
        ) : data.map((session: any) => (
          <Card key={session.id}>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-gray-800 hover:text-rsn-red cursor-pointer" onClick={() => navigate(`/sessions/${session.id}`)}>{session.title}</h3>
                  <Badge variant={sessionStatusColor(session.status)}>{sessionStatusLabel(session.status)}</Badge>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Scheduled: {formatDateTime(session.scheduledAt)} · Participants: {session.participantCount || '—'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {session.status !== 'cancelled' && session.status !== 'completed' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { if (confirm('Cancel this event?')) cancelMutation.mutate(session.id); }}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                )}
                {isSuperAdmin && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => { if (confirm('PERMANENTLY delete this event and ALL its matches, ratings, and data? This cannot be undone.')) hardDeleteMutation.mutate(session.id); }}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete Forever
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
