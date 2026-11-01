// client/src/features/admin/users/UserStatusTabs.tsx
// Active / Suspended / Removed / Banned, each with how many accounts it holds (for the same search and role).
// Two by two on a phone, four in a row from 640px.
import type { UserStatusCounts } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { STATUS_TABS, type AccountStatus } from './user-status';

interface Props { current: AccountStatus; counts: UserStatusCounts | null; onChange: (status: AccountStatus) => void }

export default function UserStatusTabs({ current, counts, onChange }: Props) {
  return (
    <div role="tablist" aria-label="Accounts by status" className="grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1 sm:grid-cols-4">
      {STATUS_TABS.map((tab) => {
        const on = tab.status === current;
        return (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={on}
            data-testid={`admin-users-tab-${tab.status}`}
            onClick={() => onChange(tab.status)}
            className={cn(
              'flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors',
              on ? 'bg-white text-[#1a1a2e] shadow-sm' : 'text-gray-600 hover:text-gray-800',
            )}
          >
            {tab.label}
            <span
              data-testid={`admin-users-count-${tab.status}`}
              className={cn('min-w-[1.5rem] rounded-full px-1.5 text-xs tabular-nums', on ? 'bg-gray-100 text-gray-700' : 'bg-white/70 text-gray-500')}
            >
              {counts ? counts[tab.status] : '…'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
