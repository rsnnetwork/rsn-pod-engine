import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Users, Plus, Globe, Lock, Shield, Eye, UserCheck, UserPlus, Search } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';
import CreatePodModal from './CreatePodModal';

type PodFilter = 'browse' | 'active' | 'archived' | 'all';

const VISIBILITY_CONFIG: Record<string, { label: string; icon: typeof Eye; variant: 'default' | 'warning' | 'info' | 'success' }> = {
  public:               { label: 'Public',             icon: Eye,       variant: 'info' },
  invite_only:          { label: 'Invite Only',         icon: Shield,    variant: 'warning' },
  private:              { label: 'Private',             icon: Lock,      variant: 'default' },
  public_with_approval: { label: 'Public + Approval',  icon: UserCheck, variant: 'info' },
  request_to_join:      { label: 'Request to Join',     icon: UserPlus,  variant: 'success' },
};

export default function PodsPage() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<PodFilter>('browse');
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['my-pods', filter],
    queryFn: () => {
      if (filter === 'browse') {
        // Browse shows all non-private active pods across the platform
        return api.get('/pods?browse=true').then(r => r.data.data ?? []);
      }
      const params = filter === 'all' ? '' : `?status=${filter}`;
      return api.get(`/pods${params}`).then(r => r.data.data ?? []);
    },
  });

  // Client-side search filter
  const filteredData = useMemo(() => {
    if (!data || !search.trim()) return data;
    const q = search.toLowerCase();
    return data.filter((pod: any) =>
      pod.name?.toLowerCase().includes(q) || pod.description?.toLowerCase().includes(q)
    );
  }, [data, search]);

  if (isLoading) return <PageLoader />;

  const isBrowse = filter === 'browse';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">
            {isBrowse ? 'Browse All Pods' : 'My Pods'}
          </h1>
          {isBrowse && (
            <p className="text-sm text-gray-400 mt-0.5">Community pods open for joining — not your own pods</p>
          )}
        </div>
        <Button onClick={() => setShowCreate(true)} className="btn-glow">
          <Plus className="h-4 w-4 mr-2" /> Create Pod
        </Button>
      </div>

      {/* Tabs — order: Browse All | Active | Archived | All */}
      <div className="flex gap-2 flex-wrap animate-fade-in-up">
        {([
          { key: 'browse',   label: 'Browse All', icon: Globe },
          { key: 'active',   label: 'Active',     icon: null },
          { key: 'archived', label: 'Archived',   icon: null },
          { key: 'all',      label: 'All',        icon: null },
        ] as { key: PodFilter; label: string; icon: typeof Globe | null }[]).map(({ key, label, icon: Icon }) => (
          <Button
            key={key}
            variant={filter === key ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setFilter(key)}
          >
            {Icon ? <><Icon className="h-3.5 w-3.5 mr-1" /> {label}</> : label}
          </Button>
        ))}
      </div>

      {/* Search */}
      <div className="relative animate-fade-in-up">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search pods by name..."
          className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-rsn-red/20 focus:border-rsn-red/40 placeholder-gray-400"
        />
      </div>

      {/* Browse mode callout */}
      {isBrowse && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 flex items-center gap-2">
          <Globe className="h-4 w-4 shrink-0" />
          <span>You're browsing community pods. Switch to <strong>Active</strong> to see your own pods.</span>
        </div>
      )}

      {/* Pod list */}
      {(!filteredData || filteredData.length === 0) ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title={
            filter === 'archived' ? 'No archived pods'
            : filter === 'browse' ? 'No community pods found'
            : filter === 'active' ? 'No active pods'
            : 'No pods yet'
          }
          description={
            filter === 'archived' ? 'Archived pods will appear here.'
            : filter === 'browse' ? 'Be the first to create a pod!'
            : filter === 'active' ? 'Create your first pod or browse existing ones.'
            : 'Create your first pod or browse existing ones.'
          }
          action={filter !== 'archived' ? <Button onClick={() => setShowCreate(true)}>Create Pod</Button> : undefined}
        />
      ) : (
        <div className="grid gap-4 animate-fade-in-up">
          {filteredData.map((pod: any) => {
            const vis = VISIBILITY_CONFIG[pod.visibility] || VISIBILITY_CONFIG.public;
            const VisIcon = vis.icon;
            return (
              <Card key={pod.id} hover onClick={() => navigate(`/pods/${pod.id}`)} className="card-hover">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-rsn-red-light flex items-center justify-center shrink-0">
                      <Users className="h-5 w-5 text-rsn-red" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-800">{pod.name}</p>
                      <p className="text-sm text-gray-500">
                        {pod.memberCount || 0} members · {pod.sessionCount || 0} events
                        {pod.description ? ` · ${pod.description}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Always show visibility badge on browse; show on my-pods too for context */}
                    <Badge variant={vis.variant} className="text-xs flex items-center gap-1">
                      <VisIcon className="h-3 w-3" /> {vis.label}
                    </Badge>
                    <Badge variant={pod.status === 'active' ? 'success' : pod.status === 'archived' ? 'default' : 'warning'}>
                      {pod.status}
                    </Badge>
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
