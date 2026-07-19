// ─── Circles Page ────────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). Circles are communities — groups of people
// with the same intent/type (Stefan's definition). Open join. Admins can
// create circles here (v1 is admin-created, per his answer "we do").

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { CircleDashed, Users, Plus, X } from 'lucide-react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import EmptyState from '@/components/ui/EmptyState';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';

interface CircleSummary {
  id: string;
  name: string;
  description: string | null;
  parentCircleId: string | null;
  memberCount: number;
  podCount: number;
  isMember: boolean;
}

export default function CirclesPage() {
  const { user } = useAuthStore();
  const admin = isAdmin(user?.role);
  const { addToast } = useToastStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const { data: circles, isLoading } = useQuery<CircleSummary[]>({
    queryKey: ['circles'],
    queryFn: () => api.get('/circles').then(r => r.data.data ?? []),
  });

  const joinLeave = async (c: CircleSummary) => {
    if (busy) return;
    setBusy(c.id);
    try {
      await api.post(`/circles/${c.id}/${c.isMember ? 'leave' : 'join'}`);
      await queryClient.invalidateQueries({ queryKey: ['circles'] });
      addToast(c.isMember ? `Left ${c.name}` : `Welcome to ${c.name}!`, 'success');
    } catch {
      addToast('That didn\'t work — try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (name.length < 2) { addToast('Give the circle a name.', 'error'); return; }
    try {
      const res = await api.post('/circles', { name, description: newDesc.trim() || null });
      setCreating(false); setNewName(''); setNewDesc('');
      await queryClient.invalidateQueries({ queryKey: ['circles'] });
      navigate(`/circles/${res.data.data.id}`);
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Could not create the circle.', 'error');
    }
  };

  if (isLoading) return <PageLoader />;

  // v1 list shows top-level circles; children appear on their parent's page.
  const topLevel = (circles ?? []).filter(c => !c.parentCircleId);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Circles</h1>
          <p className="text-gray-500 text-sm mt-1">Communities of people who share your intent</p>
        </div>
        <div className="flex items-center gap-2">
          {admin && (
            <Button size="sm" onClick={() => setCreating(v => !v)} className="min-h-[44px]">
              {creating ? <X className="h-4 w-4 mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
              {creating ? 'Cancel' : 'New circle'}
            </Button>
          )}
          <CircleDashed className="h-8 w-8 text-rsn-red" />
        </div>
      </div>

      {creating && admin && (
        <Card className="animate-fade-in-up">
          <div className="space-y-3">
            <input
              value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="Circle name (e.g. Founders)"
              maxLength={120}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30 min-h-[44px]"
            />
            <textarea
              value={newDesc} onChange={e => setNewDesc(e.target.value)}
              placeholder="What is this circle about?"
              maxLength={2000} rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30"
            />
            <Button onClick={create} className="min-h-[44px]">Create circle</Button>
          </div>
        </Card>
      )}

      {topLevel.length === 0 ? (
        <EmptyState
          title="No circles yet"
          description={admin ? 'Create the first circle to get things going.' : 'Circles are coming soon — you\'ll see them here.'}
          icon={<CircleDashed className="h-12 w-12" />}
        />
      ) : (
        <div className="grid gap-3 animate-fade-in-up">
          {topLevel.map(c => (
            <Card key={c.id} className="card-hover">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                <Link to={`/circles/${c.id}`} className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900">{c.name}</p>
                  {c.description && (
                    <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{c.description}</p>
                  )}
                  <p className="flex items-center gap-1.5 text-xs text-gray-400 mt-2">
                    <Users className="h-3.5 w-3.5" />
                    {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
                    {c.podCount > 0 && <> · {c.podCount} {c.podCount === 1 ? 'pod' : 'pods'}</>}
                  </p>
                </Link>
                <Button
                  size="sm"
                  variant={c.isMember ? 'ghost' : 'primary'}
                  onClick={() => joinLeave(c)}
                  disabled={busy === c.id}
                  className="min-h-[44px] shrink-0"
                >
                  {busy === c.id ? '…' : c.isMember ? 'Leave' : 'Join'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
