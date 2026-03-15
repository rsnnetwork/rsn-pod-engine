import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Users, Plus, Globe, Lock, Shield, Eye } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';
import CreatePodModal from './CreatePodModal';

type PodFilter = 'all' | 'active' | 'archived' | 'browse';

const visibilityConfig: Record<string, { label: string; icon: typeof Eye; variant: 'default' | 'warning' | 'info' }> = {
  public: { label: 'Public', icon: Eye, variant: 'info' },
  invite_only: { label: 'Invite Only', icon: Shield, variant: 'warning' },
  private: { label: 'Private', icon: Lock, variant: 'default' },
};

export default function PodsPage() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<PodFilter>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['my-pods', filter],
    queryFn: () => {
      if (filter === 'browse') {
        return api.get('/pods?browse=true').then(r => r.data.data ?? []);
      }
      const params = filter === 'all' ? '' : `?status=${filter}`;
      return api.get(`/pods${params}`).then(r => r.data.data ?? []);
    },
  });

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">{filter === 'browse' ? 'Browse Pods' : 'My Pods'}</h1>
        <Button onClick={() => setShowCreate(true)} className="btn-glow"><Plus className="h-4 w-4 mr-2" /> Create Pod</Button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 animate-fade-in-up">
        {(['all', 'active', 'archived', 'browse'] as PodFilter[]).map(f => (
          <Button key={f} variant={filter === f ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>
            {f === 'browse' ? <><Globe className="h-3.5 w-3.5 mr-1" /> Browse All</> : f.charAt(0).toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>

      {(!data || data.length === 0) ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title={filter === 'archived' ? 'No archived pods' : filter === 'browse' ? 'No active pods found' : 'No pods yet'}
          description={filter === 'archived' ? 'Archived pods will appear here.' : filter === 'browse' ? 'Be the first to create a pod!' : 'Create your first pod or browse existing ones.'}
          action={filter !== 'archived' ? <Button onClick={() => setShowCreate(true)}>Create Pod</Button> : undefined}
        />
      ) : (
        <div className="grid gap-4 animate-fade-in-up">
          {data.map((pod: any) => {
            const vis = visibilityConfig[pod.visibility] || visibilityConfig.public;
            const VisIcon = vis.icon;
            return (
              <Card key={pod.id} hover onClick={() => navigate(`/pods/${pod.id}`)} className="card-hover">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-rsn-red-light flex items-center justify-center">
                      <Users className="h-5 w-5 text-rsn-red" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-800">{pod.name}</p>
                      <p className="text-sm text-gray-500">
                        {pod.memberCount || 0} members · {pod.sessionCount || 0} events · {pod.description || 'General'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {filter === 'browse' && (
                      <Badge variant={vis.variant} className="text-xs flex items-center gap-1">
                        <VisIcon className="h-3 w-3" /> {vis.label}
                      </Badge>
                    )}
                    <Badge variant={pod.status === 'active' ? 'success' : pod.status === 'archived' ? 'default' : 'warning'}>{pod.status}</Badge>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <CreatePodModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
