import { useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Search, ChevronLeft, ChevronRight, Ban, Trash2, UserX, RotateCcw, Settings } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import Modal from '@/components/ui/Modal';
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
  const debouncedSearch = useDebouncedValue(search, 300);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusTab, setStatusTab] = useState<StatusTab>('active');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [entitlementUser, setEntitlementUser] = useState<any | null>(null);
  const [entitlements, setEntitlements] = useState<any>(null);

  const activeTabConfig = TAB_CONFIG.find(t => t.key === statusTab)!;

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', page, debouncedSearch, roleFilter, statusTab],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', '20');
      if (debouncedSearch) params.set('search', debouncedSearch);
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
  const bulkMutation = useMutation({
    mutationFn: ({ action, value }: { action: string; value?: string }) =>
      api.post('/admin/users/bulk-action', { userIds: Array.from(selected), action, value }),
    onSuccess: (_, { action }) => {
      invalidateUsers();
      const label = action === 'activate' ? 'reactivated' : action === 'change_role' ? 'role updated' : action + 'ned';
      addToast(`${selected.size} user(s) ${label}`, 'success');
      setSelected(new Set());
    },
    onError: () => addToast('Bulk action failed', 'error'),
  });

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleAll = () => {
    const nonSelfUsers = users.filter((u: any) => u.id !== user?.id);
    if (selected.size === nonSelfUsers.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(nonSelfUsers.map((u: any) => u.id)));
    }
  };

  const openEntitlements = async (u: any) => {
    setEntitlementUser(u);
    try {
      const res = await api.get(`/admin/users/${u.id}/entitlements`);
      setEntitlements(res.data.data);
    } catch {
      setEntitlements({ maxPodsOwned: 1, maxSessionsPerMonth: 5, maxInvitesPerDay: 10, canHostSessions: false, canCreatePods: false });
    }
  };
  const saveEntitlementsMutation = useMutation({
    mutationFn: () => api.put(`/admin/users/${entitlementUser?.id}/entitlements`, entitlements),
    onSuccess: () => { addToast('Entitlements updated', 'success'); setEntitlementUser(null); },
    onError: () => addToast('Failed to save entitlements', 'error'),
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

      {/* Bulk Action Bar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-[#1a1a2e] text-white rounded-xl px-4 py-3 shadow-lg animate-fade-in">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="flex-1" />
          {statusTab === 'active' && (
            <>
              <select
                className="bg-transparent border border-gray-500 rounded text-xs text-blue-300 px-2 py-1"
                defaultValue=""
                onChange={(e) => {
                  const role = e.target.value;
                  if (role && confirm(`Change ${selected.size} user(s) to ${role}?`)) {
                    bulkMutation.mutate({ action: 'change_role', value: role });
                  }
                  e.target.value = '';
                }}
              >
                <option value="" disabled>Bulk Change Role</option>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="super_admin">Super Admin</option>
              </select>
              <Button size="sm" variant="ghost" className="!text-amber-300 !text-xs" onClick={() => { if (confirm(`Suspend ${selected.size} user(s)?`)) bulkMutation.mutate({ action: 'suspend' }); }}>
                Bulk Suspend
              </Button>
              <Button size="sm" variant="ghost" className="!text-red-300 !text-xs" onClick={() => { if (confirm(`Ban ${selected.size} user(s)?`)) bulkMutation.mutate({ action: 'ban' }); }}>
                Bulk Ban
              </Button>
            </>
          )}
          {(statusTab === 'removed' || statusTab === 'banned') && (
            <Button size="sm" variant="ghost" className="!text-emerald-300 !text-xs" onClick={() => { if (confirm(`Reactivate ${selected.size} user(s)?`)) bulkMutation.mutate({ action: 'activate' }); }}>
              Bulk Reactivate
            </Button>
          )}
          <Button size="sm" variant="ghost" className="!text-gray-300 !text-xs" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* User List */}
      {isLoading ? <PageLoader /> : (
        <div className="space-y-2 animate-fade-in-up stagger-1">
          {/* Select all checkbox */}
          {users.length > 0 && (
            <label className="flex items-center gap-2 px-4 py-1 text-xs text-gray-500 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === users.filter((u: any) => u.id !== user?.id).length}
                onChange={toggleAll}
                className="h-3.5 w-3.5 rounded border-gray-300 text-rsn-red focus:ring-rsn-red"
              />
              Select all
            </label>
          )}
          {users.map((u: any) => (
            <Card key={u.id} className={`!p-4 card-hover ${selected.has(u.id) ? 'ring-2 ring-rsn-red/30' : ''}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {u.id !== user?.id && (
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => toggleSelect(u.id)}
                      className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red shrink-0"
                    />
                  )}
                  <a href={`/profile/${u.id}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                    <Avatar src={u.avatarUrl} name={u.displayName || u.email} size="sm" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{u.displayName || 'No name'}</p>
                      <p className="text-xs text-gray-400">{u.email}</p>
                    </div>
                  </a>
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
                      <Button size="sm" variant="ghost" onClick={() => openEntitlements(u)} className="!text-blue-600 !text-xs">
                        <Settings className="h-3 w-3 mr-1" /> Limits
                      </Button>
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
      {/* Entitlements Modal */}
      {entitlementUser && entitlements && (
        <Modal open={!!entitlementUser} onClose={() => setEntitlementUser(null)} title={`Limits — ${entitlementUser.displayName || entitlementUser.email}`}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Max Pods Owned</label>
                <input type="number" min={0} max={100} value={entitlements.maxPodsOwned}
                  onChange={e => setEntitlements((p: any) => ({ ...p, maxPodsOwned: parseInt(e.target.value) || 0 }))}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Max Sessions / Month</label>
                <input type="number" min={0} max={500} value={entitlements.maxSessionsPerMonth}
                  onChange={e => setEntitlements((p: any) => ({ ...p, maxSessionsPerMonth: parseInt(e.target.value) || 0 }))}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Max Invites / Day</label>
                <input type="number" min={0} max={1000} value={entitlements.maxInvitesPerDay}
                  onChange={e => setEntitlements((p: any) => ({ ...p, maxInvitesPerDay: parseInt(e.target.value) || 0 }))}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]" />
              </div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={entitlements.canHostSessions}
                  onChange={e => setEntitlements((p: any) => ({ ...p, canHostSessions: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red" />
                Can host events
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={entitlements.canCreatePods}
                  onChange={e => setEntitlements((p: any) => ({ ...p, canCreatePods: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red" />
                Can create pods
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEntitlementUser(null)}>Cancel</Button>
              <Button onClick={() => saveEntitlementsMutation.mutate()} isLoading={saveEntitlementsMutation.isPending}>
                Save Limits
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
