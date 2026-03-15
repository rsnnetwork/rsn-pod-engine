import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Search, ChevronLeft, ChevronRight, Ban, Trash2, UserX, RotateCcw } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';

type StatusTab = 'active' | 'removed' | 'banned';

const TAB_CONFIG: { key: StatusTab; label: string; apiStatus?: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'removed', label: 'Removed', apiStatus: 'deactivated' },
  { key: 'banned', label: 'Banned', apiStatus: 'banned' },
];

export default function AdminUsersPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useToastStore(s => s.addToast);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusTab, setStatusTab] = useState<StatusTab>('active');

  const activeTabConfig = TAB_CONFIG.find(t => t.key === statusTab)!;

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', page, search, roleFilter, statusTab],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', '20');
      if (search) params.set('search', search);
      if (roleFilter) params.set('role', roleFilter);
      if (activeTabConfig.apiStatus) params.set('status', activeTabConfig.apiStatus);
      return api.get(`/users?${params.toString()}`).then(r => r.data);
    },
    enabled: isAdmin(user?.role),
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

  const users = data?.data ?? [];
  const meta = data?.meta;
  const isSuperAdmin = user?.role === 'super_admin';

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const banMutation = useMutation({
    mutationFn: (userId: string) => api.put(`/users/${userId}/status`, { status: 'banned' }),
    onSuccess: () => { invalidateUsers(); addToast('User banned', 'success'); },
  });
  const suspendMutation = useMutation({
    mutationFn: (userId: string) => api.put(`/users/${userId}/status`, { status: 'suspended' }),
    onSuccess: () => { invalidateUsers(); addToast('User suspended', 'success'); },
  });
  const activateMutation = useMutation({
    mutationFn: (userId: string) => api.put(`/users/${userId}/status`, { status: 'active' }),
    onSuccess: () => { invalidateUsers(); addToast('User reactivated', 'success'); },
  });
  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.put(`/users/${userId}/status`, { status: 'deactivated' }),
    onSuccess: () => { invalidateUsers(); addToast('User removed', 'success'); },
  });
  const deleteMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/users/${userId}`),
    onSuccess: () => { invalidateUsers(); addToast('User permanently deleted', 'success'); },
  });
  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) => api.put(`/users/${userId}/role`, { role }),
    onSuccess: () => { invalidateUsers(); addToast('Role updated', 'success'); },
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">User Management</h1>
          <p className="text-gray-500 text-sm mt-1">{meta?.totalCount || 0} users</p>
        </div>
        <Shield className="h-8 w-8 text-rsn-red" />
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 animate-fade-in">
        {TAB_CONFIG.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setStatusTab(tab.key); setPage(1); }}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              statusTab === tab.key
                ? 'bg-white text-[#1a1a2e] shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 animate-fade-in-up">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by name or email..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50 pl-10 pr-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200"
            />
          </div>
        </div>
        <select
          value={roleFilter}
          onChange={e => { setRoleFilter(e.target.value); setPage(1); }}
          className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200"
        >
          <option value="">All Roles</option>
          <option value="super_admin">Super Admin</option>
          <option value="admin">Admin</option>
          <option value="host">Host</option>
          <option value="founding_member">Founding Member</option>
          <option value="pro">Pro</option>
          <option value="member">Member</option>
          <option value="free">Free</option>
        </select>
      </div>

      {/* User List */}
      {isLoading ? <PageLoader /> : (
        <div className="space-y-2 animate-fade-in-up stagger-1">
          {users.map((u: any) => (
            <Card key={u.id} className="!p-4 card-hover">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Avatar name={u.displayName || u.email} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-gray-800">{u.displayName || 'No name'}</p>
                    <p className="text-xs text-gray-400">{u.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={u.role === 'admin' || u.role === 'super_admin' ? 'brand' : u.role === 'host' ? 'info' : u.role === 'founding_member' ? 'success' : u.role === 'pro' ? 'warning' : 'default'}>
                    {u.role}
                  </Badge>
                  <Badge variant={u.status === 'active' ? 'success' : u.status === 'banned' ? 'warning' : 'default'}>
                    {u.status}
                  </Badge>
                </div>
              </div>
              {/* Admin actions (don't show for self) */}
              {u.id !== user?.id && (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                  {statusTab === 'active' && (
                    <>
                      {/* Role selector */}
                      <select
                        value={u.role}
                        onChange={e => roleMutation.mutate({ userId: u.id, role: e.target.value })}
                        className="text-xs rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-rsn-red/30"
                      >
                        <option value="free">Free</option>
                        <option value="member">Member</option>
                        <option value="pro">Pro</option>
                        <option value="founding_member">Founding Member</option>
                        <option value="host">Host</option>
                        {isSuperAdmin && <option value="admin">Admin</option>}
                        {isSuperAdmin && <option value="super_admin">Super Admin</option>}
                      </select>
                      <Button size="sm" variant="ghost" onClick={() => suspendMutation.mutate(u.id)} className="!text-amber-600 !text-xs">
                        <UserX className="h-3 w-3 mr-1" /> Suspend
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm('Ban this user? They will be moved to the Banned tab.')) banMutation.mutate(u.id); }} className="!text-red-600 !text-xs">
                        <Ban className="h-3 w-3 mr-1" /> Ban
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm('Remove this user? They will be moved to the Removed tab and can be reactivated later.')) removeMutation.mutate(u.id); }} className="!text-orange-600 !text-xs">
                        <UserX className="h-3 w-3 mr-1" /> Remove
                      </Button>
                    </>
                  )}
                  {(statusTab === 'removed' || statusTab === 'banned') && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm('Reactivate this user? They will be moved back to the Active tab.')) activateMutation.mutate(u.id); }} className="!text-emerald-600 !text-xs">
                        <RotateCcw className="h-3 w-3 mr-1" /> Reactivate
                      </Button>
                      {isSuperAdmin && (
                        <Button size="sm" variant="ghost" onClick={() => { if (confirm('Permanently delete this user and all their data? This cannot be undone.')) deleteMutation.mutate(u.id); }} className="!text-red-600 !text-xs">
                          <Trash2 className="h-3 w-3 mr-1" /> Delete Forever
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </Card>
          ))}
          {users.length === 0 && (
            <Card>
              <p className="text-gray-400 text-sm text-center py-4">
                {statusTab === 'active' ? 'No active users found' : statusTab === 'removed' ? 'No removed users' : 'No banned users'}
              </p>
            </Card>
          )}
        </div>
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between animate-fade-in-up stagger-2">
          <p className="text-sm text-gray-400">Page {meta.page} of {meta.totalPages}</p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!meta.hasPrev} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button variant="ghost" size="sm" disabled={!meta.hasNext} onClick={() => setPage(p => p + 1)}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
