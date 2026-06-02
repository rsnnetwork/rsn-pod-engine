import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Shield, Users, Mail, Hexagon, Activity, Calendar, BarChart3, Star, Zap, TrendingUp, Handshake } from 'lucide-react';
import axios from 'axios';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';
import { E } from '@/realtime/entities';

function StatCard({ label, value, subtitle, icon: Icon, color }: { label: string; value: string | number; subtitle?: string; icon: any; color: string }) {
  return (
    <Card className="!p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-bold text-[#1a1a2e] mt-1">{value}</p>
          {subtitle && <p className="text-[11px] text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${color}`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>
    </Card>
  );
}

function MiniBarChart({ data }: { data: { date: string; count: number }[] }) {
  if (!data || data.length === 0) return <p className="text-xs text-gray-400 text-center py-4">No data yet</p>;
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex items-end gap-[3px] h-24">
      {data.map(d => (
        <div key={d.date} className="flex-1 flex flex-col items-center justify-end group relative">
          <div
            className="w-full bg-rsn-red/70 rounded-t-sm min-h-[2px] transition-all hover:bg-rsn-red"
            style={{ height: `${(d.count / max) * 100}%` }}
          />
          <div className="absolute -top-6 bg-gray-800 text-white text-[9px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none">
            {d.date.slice(5)}: {d.count}
          </div>
        </div>
      ))}
    </div>
  );
}

function HealthItem({ label, status }: { label: string; status: string }) {
  const isHealthy = status === 'Connected' || status === 'Operational' || status === 'Running' || status === 'Active';
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-sm text-gray-600">{label}</span>
      <Badge variant={isHealthy ? 'success' : 'warning'}>{status}</Badge>
    </div>
  );
}

export default function AdminDashboardPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const { data: stats } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => api.get('/admin/stats').then(r => r.data.data),
    enabled: isAdmin(user?.role),
    meta: { entities: [E.adminAnalytics] },
  });

  const { data: joinRequestsData } = useQuery({
    queryKey: ['admin-join-requests-pending'],
    queryFn: () => api.get('/join-requests?status=pending&pageSize=1').then(r => r.data),
    enabled: isAdmin(user?.role),
    meta: { entities: [E.adminJoinRequests] },
  });

  const { data: recentMatches } = useQuery({
    queryKey: ['admin-recent-matches'],
    queryFn: () => api.get('/admin/matches?limit=10').then(r => r.data.data ?? []),
    enabled: isAdmin(user?.role),
    meta: { entities: [E.adminAnalytics] },
  });

  const { data: healthData } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => {
      const base = api.defaults.baseURL?.replace(/\/api$/, '') || '';
      return axios.get(`${base}/health`).then(r => r.data).catch(() => null);
    },
    enabled: isAdmin(user?.role),
    retry: false,
  });

  if (!isAdmin(user?.role)) {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <Shield className="h-16 w-16 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Admin Only</h2>
        <p className="text-gray-500 mb-4">This page is restricted to administrators.</p>
        <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  const pendingRequests = joinRequestsData?.meta?.totalCount ?? 0;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Admin Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Platform overview and management</p>
        </div>
        <Shield className="h-8 w-8 text-red-600" />
      </div>

      {/* Stats Grid — Row 1 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-in-up">
        <StatCard label="Total Users" value={stats?.totalUsers ?? '—'} subtitle={`${stats?.activeUsers7d ?? 0} active last 7d`} icon={Users} color="bg-blue-500" />
        <StatCard label="Pending Requests" value={pendingRequests} icon={Mail} color="bg-amber-500" />
        <StatCard label="Pods" value={stats?.totalPods ?? '—'} subtitle={`${stats?.activePods ?? 0} active`} icon={Hexagon} color="bg-emerald-500" />
        <StatCard label="Events" value={stats?.totalEvents ?? '—'} subtitle={`${stats?.completedEvents ?? 0} completed`} icon={Calendar} color="bg-purple-500" />
      </div>

      {/* Stats Grid — Row 2 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-in-up">
        <StatCard label="Total Matches" value={stats?.totalMatches ?? '—'} icon={Zap} color="bg-pink-500" />
        <StatCard label="Avg Rating" value={stats?.avgRating ?? '—'} subtitle="across all events" icon={Star} color="bg-amber-600" />
        <div className="col-span-2">
          <Card className="!p-5">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">User Growth (30d)</p>
              <TrendingUp className="h-4 w-4 text-gray-300" />
            </div>
            <MiniBarChart data={stats?.userGrowth ?? []} />
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Quick Actions */}
        <Card className="animate-fade-in-up">
          <h2 className="font-semibold text-[#1a1a2e] mb-4 flex items-center gap-2">
            <Activity className="h-5 w-5 text-rsn-red" /> Quick Actions
          </h2>
          <div className="space-y-2">
            {([
              { path: '/admin/analytics', icon: BarChart3, label: 'Analytics', badge: null },
              { path: '/admin/users', icon: Users, label: 'Manage Users', badge: null },
              { path: '/admin/join-requests', icon: Mail, label: 'Join Requests', badge: pendingRequests > 0 ? `${pendingRequests} pending` : null },
              { path: '/admin/pods', icon: Hexagon, label: 'Manage Pods', badge: null },
              { path: '/admin/sessions', icon: Calendar, label: 'Manage Events', badge: null },
              { path: '/admin/moderation', icon: Shield, label: 'Moderation Queue', badge: null },
              { path: '/admin/templates', icon: BarChart3, label: 'Matching Templates', badge: null },
              { path: '/admin/email', icon: Mail, label: 'Email Controls', badge: null },
            ] as const).map(item => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 transition-colors flex items-center justify-between group"
              >
                <div className="flex items-center gap-3">
                  <item.icon className="h-4 w-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-700">{item.label}</span>
                  {item.badge && <Badge variant="warning">{item.badge}</Badge>}
                </div>
                <span className="text-xs text-gray-400 group-hover:text-gray-600">&rarr;</span>
              </button>
            ))}
          </div>
        </Card>

        {/* System Health */}
        <Card className="animate-fade-in-up">
          <h2 className="font-semibold text-[#1a1a2e] mb-4 flex items-center gap-2">
            <Activity className="h-5 w-5 text-emerald-600" /> System Health
          </h2>
          <div className="divide-y divide-gray-100">
            <HealthItem
              label="Database"
              status={healthData?.status === 'ok' ? 'Connected' : 'Unknown'}
            />
            <HealthItem label="Auth" status="Operational" />
            <HealthItem label="LiveKit" status="Running" />
            <HealthItem label="Email (Resend)" status="Active" />
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>Environment: {healthData?.environment || '—'}</span>
              <span>v{healthData?.version || '0.1.0'}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Recent Matches */}
      {recentMatches && recentMatches.length > 0 && (
        <Card className="animate-fade-in-up">
          <h2 className="font-semibold text-[#1a1a2e] mb-4 flex items-center gap-2">
            <Handshake className="h-5 w-5 text-emerald-600" /> Recent Matches ({stats?.totalMatches ?? 0} total)
          </h2>
          <div className="space-y-3">
            {recentMatches.map((m: any) => (
              <div key={m.id} className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0">
                <div className="flex items-center gap-3">
                  <div className="flex items-center -space-x-2">
                    <Avatar src={m.participantAAvatarUrl} name={m.participantAName || 'User A'} size="sm" />
                    <Avatar src={m.participantBAvatarUrl} name={m.participantBName || 'User B'} size="sm" />
                    {m.participantCName && (
                      <Avatar src={m.participantCAvatarUrl} name={m.participantCName} size="sm" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {m.participantAName || m.participantAEmail}
                      <span className="text-gray-400 mx-1">&harr;</span>
                      {m.participantBName || m.participantBEmail}
                      {m.participantCName && (
                        <><span className="text-gray-400 mx-1">&harr;</span>{m.participantCName}</>
                      )}
                    </p>
                    <p className="text-xs text-gray-400">
                      {m.sessionTitle} &middot; Round {m.roundNumber}
                      {m.sessionDate && <> &middot; {new Date(m.sessionDate).toLocaleDateString()}</>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {m.score && <span className="text-xs text-gray-500">Score: {parseFloat(m.score).toFixed(1)}</span>}
                  <Badge variant={m.status === 'completed' ? 'success' : m.status === 'active' ? 'brand' : 'default'}>
                    {m.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
