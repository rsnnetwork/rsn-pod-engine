// ─── Admin Analytics Page ──────────────────────────────────────────────────
//
// Phase 7C.4 (7 May spec, Stefan #6) — cross-event analytics dashboard.
//
// Four panels backed by /admin/analytics/{overview,events,users,connections}:
//   1. Overview — top-line numbers, last 30 days
//   2. Events — sortable per-event table, last 90 days
//   3. Users — top users by composite score (50% avg quality + 50% meet-again)
//   4. Connections — frequency-ranked pair list (data shaped for a future
//      force-directed graph upgrade; today rendered as a list)
//
// CSV download per panel via /admin/analytics/export/:type.csv.
// Server caches each query for 60s — page reloads are cheap.

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import {
  Shield,
  BarChart3,
  Calendar,
  Sparkles,
  Star,
  TrendingDown,
  Network,
  Download,
  ExternalLink,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';

interface OverviewData {
  windowDays: number;
  totalEvents: number;
  completedEvents: number;
  completionRate: number;
  totalRatings: number;
  avgQuality: number | null;
  mutualCount: number;
  meetingTotal: number;
  mutualRate: number;
  droppedCount: number;
  totalParticipations: number;
  dropoffRate: number;
}

interface EventRow {
  id: string;
  name: string;
  scheduledAt: string | null;
  status: string;
  participants: number;
  completedParticipants: number;
  avgQuality: number | null;
  mutualCount: number;
  meetingTotal: number;
  mutualRate: number;
  dropoffRate: number;
}

interface UserRow {
  userId: string;
  displayName: string | null;
  totalMeetings: number;
  avgQualityReceived: number | null;
  meetAgainRate: number;
  compositeScore: number;
}

interface ConnectionsData {
  nodes: Array<{ id: string; displayName: string | null }>;
  edges: Array<{ a: string; b: string; weight: number }>;
}

type Tab = 'overview' | 'events' | 'users' | 'connections';

export default function AdminAnalyticsPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');

  if (!user || !isAdmin(user.role)) {
    return (
      <div className="px-6 py-12 max-w-md mx-auto text-center">
        <Shield className="h-10 w-10 mx-auto text-red-500" />
        <h1 className="mt-3 text-lg font-semibold text-gray-900">Admins only</h1>
        <p className="mt-2 text-sm text-gray-500">This page is restricted to admins.</p>
        <Button className="mt-4" onClick={() => navigate('/')}>Go home</Button>
      </div>
    );
  }

  const overviewQuery = useQuery<OverviewData>({
    queryKey: ['admin-analytics-overview'],
    queryFn: async () => (await api.get('/admin/analytics/overview')).data.data,
    staleTime: 30_000,
  });
  const eventsQuery = useQuery<EventRow[]>({
    queryKey: ['admin-analytics-events'],
    queryFn: async () => (await api.get('/admin/analytics/events')).data.data,
    staleTime: 30_000,
    enabled: tab === 'events',
  });
  const usersQuery = useQuery<UserRow[]>({
    queryKey: ['admin-analytics-users'],
    queryFn: async () => (await api.get('/admin/analytics/users')).data.data,
    staleTime: 30_000,
    enabled: tab === 'users',
  });
  const connectionsQuery = useQuery<ConnectionsData>({
    queryKey: ['admin-analytics-connections'],
    queryFn: async () => (await api.get('/admin/analytics/connections')).data.data,
    staleTime: 30_000,
    enabled: tab === 'connections',
  });

  const downloadCsv = (type: 'events' | 'users' | 'connections') => {
    // Use the api base URL so the auth cookie/header chain matches the
    // current session. Server sets Content-Disposition; the browser saves.
    const url = `${(api.defaults.baseURL || '').replace(/\/$/, '')}/admin/analytics/export/${type}.csv`;
    window.open(url, '_blank');
  };

  return (
    <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-rsn-red" /> Analytics
          </h1>
          <p className="text-sm text-gray-500">Cross-event aggregates, last 30–90 days. Cached for 60s.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4 border-b border-gray-200">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} icon={Sparkles}>Overview</TabButton>
        <TabButton active={tab === 'events'} onClick={() => setTab('events')} icon={Calendar}>Events</TabButton>
        <TabButton active={tab === 'users'} onClick={() => setTab('users')} icon={Star}>Users</TabButton>
        <TabButton active={tab === 'connections'} onClick={() => setTab('connections')} icon={Network}>Connections</TabButton>
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <OverviewPanel q={overviewQuery} />
      )}

      {/* Events */}
      {tab === 'events' && (
        <EventsPanel q={eventsQuery} onDownload={() => downloadCsv('events')} />
      )}

      {/* Users */}
      {tab === 'users' && (
        <UsersPanel q={usersQuery} onDownload={() => downloadCsv('users')} />
      )}

      {/* Connections */}
      {tab === 'connections' && (
        <ConnectionsPanel q={connectionsQuery} onDownload={() => downloadCsv('connections')} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 -mb-px text-sm border-b-2 transition-colors ${
        active
          ? 'border-rsn-red text-gray-900 font-medium'
          : 'border-transparent text-gray-500 hover:text-gray-900'
      }`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

// ─── Panels ─────────────────────────────────────────────────────────────────

function OverviewPanel({ q }: { q: ReturnType<typeof useQuery<OverviewData>> }) {
  if (q.isLoading) return <PanelLoader />;
  if (q.isError || !q.data) return <PanelError />;
  const d = q.data;
  return (
    <div>
      <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">Last {d.windowDays} days</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <Stat label="Events" value={d.totalEvents} sub={`${d.completedEvents} completed`} />
        <Stat label="Completion rate" value={pct(d.completionRate)} />
        <Stat label="Ratings collected" value={d.totalRatings} />
        <Stat label="Avg quality" value={d.avgQuality === null ? '—' : d.avgQuality.toFixed(2)} sub="out of 5" />
        <Stat label="Mutual matches" value={d.mutualCount} sub={`${pct(d.mutualRate)} of ${d.meetingTotal} meetings`} tone="emerald" />
        <Stat label="Dropoff rate" value={pct(d.dropoffRate)} sub={`${d.droppedCount} of ${d.totalParticipations}`} tone={d.dropoffRate > 0.2 ? 'red' : 'gray'} icon={TrendingDown} />
      </div>
    </div>
  );
}

function EventsPanel({
  q,
  onDownload,
}: {
  q: ReturnType<typeof useQuery<EventRow[]>>;
  onDownload: () => void;
}) {
  const navigate = useNavigate();
  const rows = q.data || [];
  const [sortBy, setSortBy] = useState<keyof EventRow>('scheduledAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortBy] ?? '';
      const bv = b[sortBy] ?? '';
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sortBy, sortDir]);

  if (q.isLoading) return <PanelLoader />;
  if (q.isError) return <PanelError />;

  const setSort = (k: keyof EventRow) => {
    if (sortBy === k) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(k); setSortDir('desc'); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] text-gray-400 uppercase tracking-wide">Last 90 days · {rows.length} events</p>
        <Button size="sm" variant="ghost" onClick={onDownload}>
          <Download className="h-3.5 w-3.5 mr-1" /> CSV
        </Button>
      </div>
      <Card className="!p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <Th onClick={() => setSort('name')}>Event</Th>
              <Th onClick={() => setSort('scheduledAt')} active={sortBy === 'scheduledAt'} dir={sortDir}>Scheduled</Th>
              <Th onClick={() => setSort('participants')} active={sortBy === 'participants'} dir={sortDir}>Participants</Th>
              <Th onClick={() => setSort('avgQuality')} active={sortBy === 'avgQuality'} dir={sortDir}>Avg quality</Th>
              <Th onClick={() => setSort('mutualRate')} active={sortBy === 'mutualRate'} dir={sortDir}>Mutual rate</Th>
              <Th onClick={() => setSort('dropoffRate')} active={sortBy === 'dropoffRate'} dir={sortDir}>Dropoff</Th>
              <th className="px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-900 truncate max-w-[18rem]">{r.name || '(unnamed)'}</div>
                  <div className="text-[11px] text-gray-400">{r.status}</div>
                </td>
                <td className="px-3 py-2 text-gray-700">{r.scheduledAt ? new Date(r.scheduledAt).toLocaleDateString() : '—'}</td>
                <td className="px-3 py-2 text-gray-700">{r.participants} <span className="text-gray-400 text-[11px]">({r.completedParticipants} done)</span></td>
                <td className="px-3 py-2 text-gray-700">{r.avgQuality === null ? '—' : r.avgQuality.toFixed(2)}</td>
                <td className="px-3 py-2 text-gray-700">{pct(r.mutualRate)}</td>
                <td className={`px-3 py-2 ${r.dropoffRate > 0.2 ? 'text-red-600' : 'text-gray-700'}`}>{pct(r.dropoffRate)}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => navigate(`/sessions/${r.id}`)} className="text-gray-400 hover:text-gray-700" title="Open event">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-gray-500">No events in the last 90 days.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function UsersPanel({
  q,
  onDownload,
}: {
  q: ReturnType<typeof useQuery<UserRow[]>>;
  onDownload: () => void;
}) {
  const navigate = useNavigate();
  const rows = q.data || [];
  if (q.isLoading) return <PanelLoader />;
  if (q.isError) return <PanelError />;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] text-gray-400 uppercase tracking-wide">Min 5 meetings · last 90 days · {rows.length} users</p>
        <Button size="sm" variant="ghost" onClick={onDownload}>
          <Download className="h-3.5 w-3.5 mr-1" /> CSV
        </Button>
      </div>
      <Card className="!p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left w-12">Rank</th>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Meetings</th>
              <th className="px-3 py-2 text-left">Avg quality</th>
              <th className="px-3 py-2 text-left">Meet-again rate</th>
              <th className="px-3 py-2 text-left">Composite</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={r.userId} className="hover:bg-gray-50">
                <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                <td className="px-3 py-2">
                  <button onClick={() => navigate(`/profile/${r.userId}`)} className="font-medium text-gray-900 hover:text-rsn-red">
                    {r.displayName || '(no name)'}
                  </button>
                </td>
                <td className="px-3 py-2 text-gray-700">{r.totalMeetings}</td>
                <td className="px-3 py-2 text-gray-700">{r.avgQualityReceived === null ? '—' : r.avgQualityReceived.toFixed(2)}</td>
                <td className="px-3 py-2 text-gray-700">{pct(r.meetAgainRate)}</td>
                <td className="px-3 py-2">
                  <span className="font-medium text-gray-900">{(r.compositeScore * 100).toFixed(0)}%</span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-500">No users meet the 5-meeting threshold yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ConnectionsPanel({
  q,
  onDownload,
}: {
  q: ReturnType<typeof useQuery<ConnectionsData>>;
  onDownload: () => void;
}) {
  const data = q.data;
  if (q.isLoading) return <PanelLoader />;
  if (q.isError || !data) return <PanelError />;

  const nameMap = new Map(data.nodes.map(n => [n.id, n.displayName]));
  const sorted = [...data.edges].sort((a, b) => b.weight - a.weight);
  const maxWeight = sorted[0]?.weight ?? 1;
  const top = sorted.slice(0, 50);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] text-gray-400 uppercase tracking-wide">{data.nodes.length} users · {data.edges.length} mutual pairs · top 50</p>
        <Button size="sm" variant="ghost" onClick={onDownload}>
          <Download className="h-3.5 w-3.5 mr-1" /> CSV
        </Button>
      </div>
      <Card className="!p-3">
        <ul className="space-y-1">
          {top.map(e => (
            <li key={`${e.a}-${e.b}`} className="flex items-center gap-3 text-sm">
              <div className="flex-1 min-w-0 truncate">
                <span className="font-medium text-gray-900">{nameMap.get(e.a) || '(no name)'}</span>
                <span className="text-gray-400 mx-1.5">×</span>
                <span className="font-medium text-gray-900">{nameMap.get(e.b) || '(no name)'}</span>
              </div>
              <div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-400" style={{ width: `${(e.weight / maxWeight) * 100}%` }} />
              </div>
              <span className="text-xs text-gray-500 w-8 text-right">{e.weight}</span>
            </li>
          ))}
        </ul>
        {top.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-gray-500">No mutual connections in the last 90 days yet.</p>
        )}
      </Card>
    </div>
  );
}

// ─── Atoms ──────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'emerald' | 'red' | 'gray';
  icon?: any;
}) {
  const toneClass =
    tone === 'emerald' ? 'text-emerald-600' :
    tone === 'red' ? 'text-red-600' :
    'text-gray-900';
  return (
    <Card className="!p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide truncate">{label}</p>
          <p className={`text-xl font-bold mt-1 ${toneClass}`}>{value}</p>
          {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
        </div>
        {Icon && <Icon className="h-4 w-4 text-gray-300" />}
      </div>
    </Card>
  );
}

function Th({
  onClick,
  active,
  dir,
  children,
}: {
  onClick?: () => void;
  active?: boolean;
  dir?: 'asc' | 'desc';
  children: React.ReactNode;
}) {
  return (
    <th className="px-3 py-2 text-left">
      <button onClick={onClick} className={`inline-flex items-center gap-1 transition-colors ${active ? 'text-gray-900' : 'hover:text-gray-700'}`}>
        {children}
        {active && <span className="text-[9px]">{dir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  );
}

function PanelLoader() {
  return <p className="py-8 text-center text-sm text-gray-500">Loading…</p>;
}

function PanelError() {
  return <p className="py-8 text-center text-sm text-red-600">Could not load analytics.</p>;
}

function pct(v: number): string {
  if (!isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

