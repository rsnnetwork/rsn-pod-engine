import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Users, Plus } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';
import CreatePodModal from './CreatePodModal';

export default function PodsPage() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['my-pods'],
    queryFn: () => api.get('/pods').then(r => r.data.data ?? []),
  });

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-surface-100">My Pods</h1>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" /> Create Pod</Button>
      </div>

      {(!data || data.length === 0) ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="No pods yet"
          description="Create your first pod to start networking with peers."
          action={<Button onClick={() => setShowCreate(true)}>Create Pod</Button>}
        />
      ) : (
        <div className="grid gap-4">
          {data.map((pod: any) => (
            <Card key={pod.id} hover onClick={() => navigate(`/pods/${pod.id}`)}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-brand-500/20 flex items-center justify-center">
                    <Users className="h-5 w-5 text-brand-400" />
                  </div>
                  <div>
                    <p className="font-medium text-surface-200">{pod.name}</p>
                    <p className="text-sm text-surface-400">{pod.memberCount || 0} members · {pod.description || 'General'}</p>
                  </div>
                </div>
                <Badge variant={pod.status === 'active' ? 'success' : 'default'}>{pod.status}</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreatePodModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
