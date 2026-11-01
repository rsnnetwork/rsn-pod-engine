// client/src/features/admin/users/AdminUserRow.tsx
// One account on the admin Users page: who they are, their role and status in words, and what can be done to them
// from the tab they are in. Nothing is offered on the admin's own row.
import { Link } from 'react-router-dom';
import { Ban, RotateCcw, Settings, Trash2, UserMinus, UserX, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import {
  ACTION_LABEL, ROLE_LABEL, STATUS_LABEL, actionsFor, roleChoices, roleIsEditable,
  type AccountStatus, type StatusAction,
} from './user-status';
import type { AdminUserRowData } from './useStatusAction';

const ACTION_ICON: Record<StatusAction, ReactNode> = {
  suspend: <UserMinus className="h-4 w-4" aria-hidden="true" />,
  ban: <Ban className="h-4 w-4" aria-hidden="true" />,
  remove: <UserX className="h-4 w-4" aria-hidden="true" />,
  activate: <RotateCcw className="h-4 w-4" aria-hidden="true" />,
  delete: <Trash2 className="h-4 w-4" aria-hidden="true" />,
};

const ACTION_TONE: Record<StatusAction, string> = {
  suspend: 'text-amber-700 hover:bg-amber-50',
  ban: 'text-red-700 hover:bg-red-50',
  remove: 'text-orange-700 hover:bg-orange-50',
  activate: 'text-emerald-700 hover:bg-emerald-50',
  delete: 'text-red-700 hover:bg-red-50',
};

const ACTION_BUTTON = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:opacity-50';

interface Props {
  user: AdminUserRowData;
  tab: AccountStatus;
  isSelf: boolean;
  isSuperAdmin: boolean;
  selected: boolean;
  busy: boolean;
  roleBusy: boolean;
  onToggleSelect: () => void;
  onAction: (action: StatusAction) => void;
  onRole: (role: string) => void;
  onLimits: () => void;
}

export default function AdminUserRow({
  user: u, tab, isSelf, isSuperAdmin, selected, busy, roleBusy, onToggleSelect, onAction, onRole, onLimits,
}: Props) {
  const roleLabel = ROLE_LABEL[u.role] ?? u.role;
  const choices = roleChoices(isSuperAdmin);
  const status = (u.status in STATUS_LABEL ? u.status : 'active') as AccountStatus;
  return (
    <Card className={cn('!p-4', selected && 'ring-2 ring-rsn-red/30')} data-testid={`admin-user-${u.id}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {!isSelf && (
            <label className="-m-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
              <input
                type="checkbox"
                checked={selected}
                onChange={onToggleSelect}
                aria-label={`Select ${u.displayName || u.email}`}
                className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red"
              />
            </label>
          )}
          <Link to={`/admin/users/${u.id}`} className="flex min-w-0 items-center gap-3 hover:opacity-80">
            <Avatar src={u.avatarUrl ?? undefined} name={u.displayName || u.email} size="sm" className="shrink-0" />
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <p className="text-sm font-medium text-gray-800">{u.displayName || 'No name'}</p>
              <p className="text-xs text-gray-500">{u.email}</p>
            </div>
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={u.role === 'admin' || u.role === 'super_admin' ? 'brand' : 'default'}>{roleLabel}</Badge>
          <Badge variant={status === 'active' ? 'success' : status === 'banned' ? 'warning' : 'default'}>{STATUS_LABEL[status]}</Badge>
        </div>
      </div>

      {!isSelf && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          {tab === 'active' && (roleIsEditable(u.role, isSuperAdmin) ? (
            <label className="inline-flex items-center gap-2 text-sm text-gray-600">
              <span className="sr-only">Role for {u.displayName || u.email}</span>
              <select
                value={u.role}
                disabled={roleBusy || busy}
                onChange={(e) => onRole(e.target.value)}
                className="min-h-[44px] rounded-lg border border-gray-200 bg-gray-50 px-2 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-rsn-red/30 disabled:opacity-50"
              >
                {!choices.includes(u.role) && <option value={u.role} disabled>{roleLabel}</option>}
                {choices.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              {roleBusy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-label="Saving the role" />}
            </label>
          ) : (
            <span className="text-xs text-gray-500">Only a super admin can change an admin&apos;s role.</span>
          ))}
          {tab === 'active' && (
            <button type="button" onClick={onLimits} disabled={busy} className={cn(ACTION_BUTTON, 'text-blue-700 hover:bg-blue-50')}>
              <Settings className="h-4 w-4" aria-hidden="true" /> Limits
            </button>
          )}
          {actionsFor(tab, isSuperAdmin).map((action) => (
            <button
              key={action}
              type="button"
              disabled={busy}
              onClick={() => onAction(action)}
              data-testid={`admin-user-${action}-${u.id}`}
              className={cn(ACTION_BUTTON, ACTION_TONE[action])}
            >
              {ACTION_ICON[action]} {ACTION_LABEL[action]}
            </button>
          ))}
          {busy && <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Saving…</span>}
        </div>
      )}
    </Card>
  );
}
