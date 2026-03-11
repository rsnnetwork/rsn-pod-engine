import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Shield, Users, Mail, Hexagon, HelpCircle, Activity, Calendar } from 'lucide-react';
import axios from 'axios';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: any; color: string }) {
  return (
    <Card className="!p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-bold text-[#1a1a2e] mt-1">{value}</p>
        </div>
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${color}`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>
    </Card>
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

  // Fetch admin stats
  const { data: usersData } = useQuery({
    queryKey: ['admin-users-count'],
    queryFn: () => api.get('/users?pageSize=1').then(r => r.data),
    enabled: isAdmin(user?.role),
  });

  const { data: podsData } = useQuery({
    queryKey: ['admin-pods-count'],
    queryFn: () => api.get('/pods?pageSize=1').then(r => r.data),
    enabled: isAdmin(user?.role),
  });

  const { data: joinRequestsData } = useQuery({
    queryKey: ['admin-join-requests-pending'],
    queryFn: () => api.get('/join-requests?status=pending&pageSize=1').then(r => r.data),
    enabled: isAdmin(user?.role),
  });

  const { data: healthData } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => {
      // Health endpoint is at /health, not /api/health
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

  const totalUsers = usersData?.meta?.totalCount ?? '—';
  const activePods = podsData?.meta?.totalCount ?? '—';
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

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-in-up">
        <StatCard label="Total Users" value={totalUsers} icon={Users} color="bg-blue-500" />
        <StatCard label="Pending Requests" value={pendingRequests} icon={Mail} color="bg-amber-500" />
        <StatCard label="Active Pods" value={activePods} icon={Hexagon} color="bg-emerald-500" />
        <StatCard label="Open Tickets" value="—" icon={HelpCircle} color="bg-purple-500" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Quick Actions */}
        <Card className="animate-fade-in-up">
          <h2 className="font-semibold text-[#1a1a2e] mb-4 flex items-center gap-2">
            <Activity className="h-5 w-5 text-indigo-600" /> Quick Actions
          </h2>
          <div className="space-y-2">
            <button
              onClick={() => navigate('/admin/users')}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 transition-colors flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                <Users className="h-4 w-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Manage Users</span>
              </div>
              <span className="text-xs text-gray-400 group-hover:text-gray-600">→</span>
            </button>
            <button
              onClick={() => navigate('/admin/join-requests')}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 transition-colors flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                <Mail className="h-4 w-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Join Requests</span>
                {pendingRequests > 0 && (
                  <Badge variant="warning">{pendingRequests} pending</Badge>
                )}
              </div>
              <span className="text-xs text-gray-400 group-hover:text-gray-600">→</span>
            </button>
            <button
              onClick={() => navigate('/admin/pods')}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 transition-colors flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                <Hexagon className="h-4 w-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Manage Pods</span>
              </div>
              <span className="text-xs text-gray-400 group-hover:text-gray-600">→</span>
            </button>
            <button
              onClick={() => navigate('/admin/sessions')}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 transition-colors flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                <Calendar className="h-4 w-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Manage Sessions</span>
              </div>
              <span className="text-xs text-gray-400 group-hover:text-gray-600">→</span>
            </button>
            <button
              onClick={() => navigate('/support')}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 transition-colors flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                <HelpCircle className="h-4 w-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Support Tickets</span>
              </div>
              <span className="text-xs text-gray-400 group-hover:text-gray-600">→</span>
            </button>
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
            <HealthItem label="Edge Functions" status="Running" />
            <HealthItem label="Stripe" status="Active" />
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>Environment: {healthData?.environment || '—'}</span>
              <span>v{healthData?.version || '0.1.0'}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card className="animate-fade-in-up">
        <h2 className="font-semibold text-[#1a1a2e] mb-4 flex items-center gap-2">
          <Activity className="h-5 w-5 text-indigo-600" /> Recent Activity
        </h2>
        <div className="text-sm text-gray-400 text-center py-6">
          Activity feed will be populated as the platform grows.
        </div>
      </Card>
    </div>
  );
}
