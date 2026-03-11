import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Hexagon, Trash2, Archive, RefreshCw } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin } from '@/lib/utils';
import api from '@/lib/api';

export default function AdminPodsPage() {
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-pods', filter],
    queryFn: () => api.get(`/pods?pageSize=100${filter !== 'all' ? `&status=${filter}` : ''}`).then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
  });

  const archiveMutation = useMutation({
    mutationFn: (podId: string) => api.delete(`/pods/${podId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-pods'] }); addToast('Pod archived', 'success'); },
    onError: () => addToast('Failed to archive pod', 'error'),
  });

  const hardDeleteMutation = useMutation({
    mutationFn: (podId: string) => api.delete(`/pods/${podId}/permanent`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-pods'] }); addToast('Pod permanently deleted', 'success'); },
    onError: () => addToast('Failed to delete pod', 'error'),
  });

  if (isLoading) return <PageLoader />;

  const isSuperAdmin = user?.role === 'super_admin';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Manage Pods</h1>
        <Hexagon className="h-6 w-6 text-indigo-600" />
      </div>

      <div className="flex gap-2">
        {(['all', 'active', 'archived'] as const).map(f => (
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
            <p className="text-gray-500">No pods found</p>
          </Card>
        ) : data.map((pod: any) => (
          <Card key={pod.id}>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-gray-800">{pod.name}</h3>
                  <Badge variant={pod.status === 'active' ? 'success' : 'default'}>{pod.status}</Badge>
                  <Badge variant="info">{pod.visibility}</Badge>
                </div>
                <p className="text-sm text-gray-500">{pod.description || 'No description'}</p>
                <p className="text-xs text-gray-400 mt-1">
                  Members: {pod.memberCount || '—'} · Sessions: {pod.sessionCount || '—'} · Type: {pod.type}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {pod.status === 'active' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { if (confirm('Archive this pod?')) archiveMutation.mutate(pod.id); }}
                  >
                    <Archive className="h-3.5 w-3.5 mr-1" /> Archive
                  </Button>
                )}
                {isSuperAdmin && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => { if (confirm('PERMANENTLY delete this pod and ALL its sessions, matches, and data? This cannot be undone.')) hardDeleteMutation.mutate(pod.id); }}
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
