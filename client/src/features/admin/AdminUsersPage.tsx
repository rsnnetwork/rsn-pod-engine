import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Shield, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';

export default function AdminUsersPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', page, search, roleFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', '20');
      if (search) params.set('search', search);
      if (roleFilter) params.set('role', roleFilter);
      return api.get(`/users?${params.toString()}`).then(r => r.data);
    },
    enabled: user?.role === 'admin',
  });

  if (user?.role !== 'admin') {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <Shield className="h-16 w-16 text-surface-600 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-surface-100 mb-2">Admin Only</h2>
        <p className="text-surface-400 mb-4">This page is restricted to administrators.</p>
        <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  const users = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-surface-100">User Management</h1>
          <p className="text-surface-400 text-sm mt-1">{meta?.totalCount || 0} total users</p>
        </div>
        <Shield className="h-8 w-8 text-brand-400" />
      </div>

      {/* Filters */}
      <div className="flex gap-3 animate-fade-in-up">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-500" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by name or email..."
              className="w-full rounded-xl border border-surface-700 bg-surface-800/50 pl-10 pr-4 py-2.5 text-sm text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all duration-200"
            />
          </div>
        </div>
        <select
          value={roleFilter}
          onChange={e => { setRoleFilter(e.target.value); setPage(1); }}
          className="rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all duration-200"
        >
          <option value="">All Roles</option>
          <option value="member">Member</option>
          <option value="host">Host</option>
          <option value="admin">Admin</option>
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
                    <p className="text-sm font-medium text-surface-200">{u.displayName || 'No name'}</p>
                    <p className="text-xs text-surface-500">{u.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={u.role === 'admin' ? 'brand' : u.role === 'host' ? 'info' : 'default'}>
                    {u.role}
                  </Badge>
                  <Badge variant={u.status === 'active' ? 'success' : 'warning'}>
                    {u.status}
                  </Badge>
                </div>
              </div>
            </Card>
          ))}
          {users.length === 0 && (
            <Card>
              <p className="text-surface-500 text-sm text-center py-4">No users found</p>
            </Card>
          )}
        </div>
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between animate-fade-in-up stagger-2">
          <p className="text-sm text-surface-500">Page {meta.page} of {meta.totalPages}</p>
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
