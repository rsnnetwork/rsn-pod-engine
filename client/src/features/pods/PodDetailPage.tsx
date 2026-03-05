import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Users, Calendar } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';

export default function PodDetailPage() {
  const { podId } = useParams();
  const navigate = useNavigate();

  const { data: pod, isLoading } = useQuery({
    queryKey: ['pod', podId],
    queryFn: () => api.get(`/pods/${podId}`).then(r => r.data.data),
  });

  if (isLoading) return <PageLoader />;
  if (!pod) return <p className="text-surface-400 text-center py-20">Pod not found</p>;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate('/pods')} className="flex items-center gap-2 text-surface-400 hover:text-surface-200 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Pods
      </button>

      <Card>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-surface-100">{pod.name}</h1>
            <p className="text-surface-400 mt-1">{pod.description || 'General focus'}</p>
          </div>
          <Badge variant={pod.status === 'active' ? 'success' : 'default'}>{pod.status}</Badge>
        </div>

        <div className="flex gap-6 text-sm text-surface-400">
          <span className="flex items-center gap-1"><Users className="h-4 w-4" /> {pod.memberCount || 0} members</span>
          <span className="flex items-center gap-1"><Calendar className="h-4 w-4" /> Created {new Date(pod.createdAt).toLocaleDateString()}</span>
        </div>
      </Card>

      {/* Members */}
      <div>
        <h2 className="text-lg font-semibold text-surface-100 mb-3">Members</h2>
        <div className="grid gap-3">
          {(pod.members || []).map((m: any) => (
            <Card key={m.userId || m.id}>
              <div className="flex items-center gap-3">
                <Avatar name={m.displayName || m.email || 'User'} size="md" />
                <div>
                  <p className="font-medium text-surface-200">{m.displayName || m.email}</p>
                  <p className="text-xs text-surface-500">{m.role || 'member'}</p>
                </div>
              </div>
            </Card>
          ))}
          {(!pod.members || pod.members.length === 0) && (
            <p className="text-surface-500 text-sm">No members yet</p>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <Button onClick={() => navigate(`/sessions/new?podId=${podId}`)}>
          <Calendar className="h-4 w-4 mr-2" /> Schedule Session
        </Button>
      </div>
    </div>
  );
}
