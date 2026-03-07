import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Plus } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import CreateInviteModal from './CreateInviteModal';
import api from '@/lib/api';

export default function InvitesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['my-invites'],
    queryFn: () => api.get('/invites').then(r => r.data.data ?? []),
  });

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <h1 className="text-2xl font-bold text-surface-100">Invites</h1>
        <Button onClick={() => setShowCreate(true)} className="btn-glow"><Plus className="h-4 w-4 mr-2" /> Create Invite</Button>
      </div>

      {(!data || data.length === 0) ? (
        <EmptyState
          icon={<Mail className="h-8 w-8" />}
          title="No invites"
          description="Create invite links to grow your pods."
          action={<Button onClick={() => setShowCreate(true)}>Create Invite</Button>}
        />
      ) : (
        <div className="grid gap-4 animate-fade-in-up">
          {data.map((inv: any) => (
            <Card key={inv.id}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-surface-200 font-mono text-sm">{inv.code}</p>
                  <p className="text-sm text-surface-400">Uses: {inv.useCount || 0}{inv.maxUses ? ` / ${inv.maxUses}` : ''}</p>
                </div>
                <Badge variant={inv.status === 'active' ? 'success' : 'default'}>{inv.status}</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateInviteModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
