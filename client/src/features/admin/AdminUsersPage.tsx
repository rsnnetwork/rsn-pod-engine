// client/src/features/admin/AdminUsersPage.tsx
// The admin Users page (T2, 1 Nov 2026): Active, Suspended, Removed and Banned tabs, each asking the server for its
// own status and saying how many it holds. Every action asks first in a ConfirmDialog, shows that it is working, then
// says how it went in a toast, and the row leaves its tab on the refetch (admin:users reaches every admin's open
// list). All hooks run before the admin check, so a role change while the page is open cannot break the page.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, Shield } from 'lucide-react';
import type { PaginationMeta } from '@rsn/shared';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';
import { E } from '@/realtime/entities';
import AdminUserRow from './users/AdminUserRow';
import UserStatusTabs from './users/UserStatusTabs';
import UsersBulkBar from './users/UsersBulkBar';
import EntitlementsModal from './users/EntitlementsModal';
import { ROLE_LABEL, STATUS_TABS, actionCopy, failureText, type AccountStatus } from './users/user-status';
import { nameOf, useStatusAction, type AdminUserRowData } from './users/useStatusAction';

const ROLE_FILTERS = ['super_admin', 'admin', 'host', 'founding_member', 'pro', 'member', 'free'];

export default function AdminUsersPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const admin = isAdmin(user?.role);
  const isSuperAdmin = user?.role === 'super_admin';

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [roleFilter, setRoleFilter] = useState('');
  const [tab, setTab] = useState<AccountStatus>('active');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limitsFor, setLimitsFor] = useState<AdminUserRowData | null>(null);
  const status = useStatusAction();

  const list = useQuery({
    queryKey: ['admin-users', page, debouncedSearch, roleFilter, tab],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20', status: tab });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (roleFilter) params.set('role', roleFilter);
      return api.get(`/users?${params.toString()}`).then((r) => r.data as { data: AdminUserRowData[]; meta: PaginationMeta });
    },
    enabled: admin,
    // The last page stays while a new search or page loads, but never another tab's rows under this tab's actions.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[4] === tab ? previous : undefined),
    meta: { entities: [E.adminUsers] },
  });

  const roleMutation = useMutation({
    mutationFn: ({ target, role }: { target: AdminUserRowData; role: string }) => api.put(`/users/${target.id}/role`, { role }),
    onSuccess: (_res, { target, role }) => addToast(`${nameOf(target)} is now ${ROLE_LABEL[role] ?? role}.`, 'success'),
    onError: (err) => addToast(failureText(err), 'error'),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ['admin-users'] }); },
  });

  if (!admin) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <Shield className="mx-auto mb-4 h-16 w-16 text-gray-300" />
        <h2 className="mb-2 text-xl font-bold text-[#1a1a2e]">Admin Only</h2>
        <p className="mb-4 text-gray-500">This page is restricted to administrators.</p>
        <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  const users = list.data?.data ?? [];
  const meta = list.data?.meta;
  const counts = meta?.statusCounts ?? null;
  const tabInfo = STATUS_TABS.find((t) => t.status === tab)!;
  const others = users.filter((u) => u.id !== user?.id);
  const chooseTab = (next: AccountStatus) => { setTab(next); setPage(1); setSelected(new Set()); };
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const asked = status.asking ? actionCopy(status.asking.action, nameOf(status.asking.user)) : null;
  const shown = counts ? counts[tab] : meta?.totalCount ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1a1a2e]">User Management</h1>
          <p className="mt-1 text-sm text-gray-500" data-testid="admin-users-heading-count">
            {shown} {tabInfo.label.toLowerCase()} {shown === 1 ? 'account' : 'accounts'}
          </p>
        </div>
        <Shield className="h-8 w-8 shrink-0 text-rsn-red" />
      </div>

      <UserStatusTabs current={tab} counts={counts} onChange={chooseTab} />

      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search by name or email</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); setSelected(new Set()); }}
            placeholder="Search by name or email..."
            className="min-h-[44px] w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-10 pr-4 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
          />
        </label>
        <label className="sm:w-48">
          <span className="sr-only">Filter by role</span>
          <select
            value={roleFilter}
            onChange={(e) => { setRoleFilter(e.target.value); setPage(1); setSelected(new Set()); }}
            className="min-h-[44px] w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
          >
            <option value="">All roles</option>
            {ROLE_FILTERS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
      </div>

      {selected.size > 0 && (
        <UsersBulkBar
          selected={Array.from(selected)}
          tab={tab}
          isSuperAdmin={isSuperAdmin}
          onDone={() => setSelected(new Set())}
          onClear={() => setSelected(new Set())}
        />
      )}

      {list.isPending ? <PageLoader /> : list.isError ? (
        <Card>
          <div className="py-4 text-center">
            <p className="text-sm text-gray-600">The accounts could not be loaded.</p>
            <Button variant="secondary" className="mt-3" onClick={() => void list.refetch()}>Try again</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-2" data-testid={`admin-users-list-${tab}`}>
          {others.length > 0 && (
            <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 px-2 text-sm text-gray-500">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === others.length}
                onChange={() => setSelected(selected.size === others.length ? new Set() : new Set(others.map((u) => u.id)))}
                className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red"
              />
              Select all on this page
            </label>
          )}
          {users.map((u) => (
            <AdminUserRow
              key={u.id}
              user={u}
              tab={tab}
              isSelf={u.id === user?.id}
              isSuperAdmin={isSuperAdmin}
              selected={selected.has(u.id)}
              busy={status.busyUserId === u.id}
              roleBusy={roleMutation.isPending && roleMutation.variables?.target.id === u.id}
              onToggleSelect={() => toggle(u.id)}
              onAction={(action) => status.ask(u, action)}
              onRole={(role) => roleMutation.mutate({ target: u, role })}
              onLimits={() => setLimitsFor(u)}
            />
          ))}
          {users.length === 0 && (
            <Card><p className="py-4 text-center text-sm text-gray-500">{debouncedSearch ? 'Nobody here matches that search.' : tabInfo.empty}</p></Card>
          )}
        </div>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">Page {meta.page} of {meta.totalPages}</p>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={!meta.hasPrev} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button variant="ghost" disabled={!meta.hasNext} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!asked}
        title={asked?.title ?? ''}
        body={asked?.body ?? ''}
        confirmLabel={asked?.confirmLabel ?? ''}
        busyLabel={asked?.busyLabel}
        tone={asked?.tone ?? 'default'}
        busy={status.busy}
        onConfirm={status.confirm}
        onCancel={status.cancel}
      />
      {limitsFor && <EntitlementsModal user={limitsFor} onClose={() => setLimitsFor(null)} />}
    </div>
  );
}
