import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, Trash2, XCircle } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin } from '@/lib/utils';
import api from '@/lib/api';

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'info' | 'default'> = {
  scheduled: 'info',
  lobby_open: 'warning',
  round_active: 'success',
  round_rating: 'warning',
  round_transition: 'warning',
  closing_lobby: 'warning',
  completed: 'default',
  cancelled: 'default',
};

export default function AdminSessionsPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-sessions', filter],
    queryFn: () => api.get(`/sessions?pageSize=100${filter !== 'all' ? `&status=${filter}` : ''}`).then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
  });

  const cancelMutation = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/sessions/${sessionId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-sessions'] }); addToast('Session cancelled', 'success'); },
    onError: () => addToast('Failed to cancel session', 'error'),
  });

  const hardDeleteMutation = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/sessions/${sessionId}/permanent`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-sessions'] }); addToast('Session permanently deleted', 'success'); },
    onError: () => addToast('Failed to delete session', 'error'),
  });

  if (isLoading) return <PageLoader />;

  const isSuperAdmin = user?.role === 'super_admin';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Manage Sessions</h1>
        <Calendar className="h-6 w-6 text-indigo-600" />
      </div>

      <div className="flex gap-2 flex-wrap">
        {['all', 'scheduled', 'completed', 'cancelled'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${filter === f ? 'bg-[#1a1a2e] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className="grid gap-4 animate-fade-in-up">
        {(!data || data.length === 0) ? (
          <Card className="text-center py-8">
            <p className="text-gray-500">No sessions found</p>
          </Card>
        ) : data.map((session: any) => (
          <Card key={session.id}>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-gray-800">{session.title}</h3>
                  <Badge variant={STATUS_VARIANT[session.status] || 'default'}>{session.status}</Badge>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Scheduled: {new Date(session.scheduledAt).toLocaleString()} · Participants: {session.participantCount || '—'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {session.status !== 'cancelled' && session.status !== 'completed' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { if (confirm('Cancel this session?')) cancelMutation.mutate(session.id); }}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                )}
                {isSuperAdmin && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => { if (confirm('PERMANENTLY delete this session and ALL its matches, ratings, and data? This cannot be undone.')) hardDeleteMutation.mutate(session.id); }}
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
