// client/src/features/admin/users/UsersBulkBar.tsx
// What the selected rows can have done to them together: on Active a role, Suspend or Ban; on the other tabs
// Reactivate; on every tab the Premium badge, given or taken off (21 Nov 2026, display only). Each asks first
// (ConfirmDialog, busy while the server answers) and says how it went in a toast.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { ROLE_LABEL, bulkCopy, failureText, roleChoices, type AccountStatus } from './user-status';
import { useProfileBadge } from './useProfileBadge';

type BulkAction = 'suspend' | 'ban' | 'activate' | 'change_role';
// The badge is its own route (PUT /admin/users/profile-badge), not a bulk-action.
type BadgeAsk = { badge: 'premium' | null };

interface Props { selected: string[]; tab: AccountStatus; isSuperAdmin: boolean; onDone: () => void; onClear: () => void }

const BAR_BUTTON = 'inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium hover:bg-white/10 disabled:opacity-50';

export default function UsersBulkBar({ selected, tab, isSuperAdmin, onDone, onClear }: Props) {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [asking, setAsking] = useState<{ action: BulkAction; role?: string } | null>(null);
  const [badgeAsk, setBadgeAsk] = useState<BadgeAsk | null>(null);
  const badge = useProfileBadge({ onDone, onSettled: () => setBadgeAsk(null) });
  const count = selected.length;
  const people = count === 1 ? '1 person' : `${count} people`;

  const mutation = useMutation({
    mutationFn: ({ action, role }: { action: BulkAction; role?: string }) =>
      api.post('/admin/users/bulk-action', { userIds: selected, action, value: role }),
    onSuccess: (_res, { action, role }) => {
      addToast(action === 'change_role' ? `${people} are now ${ROLE_LABEL[role ?? ''] ?? role}.` : bulkCopy(action, count).done, 'success');
      onDone();
    },
    onError: (err) => addToast(failureText(err), 'error'),
    onSettled: () => {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  // One change at a time from the bar, whichever kind: every button waits while either is on its way.
  const working = mutation.isPending || badge.pending;
  const badgeCopy = badgeAsk
    ? badgeAsk.badge
      ? { title: `Give ${people} the Premium badge?`, body: 'It shows beside their name wherever members are listed. It changes nothing about how they are matched.', confirmLabel: 'Give badge', busyLabel: 'Giving…' }
      : { title: `Take the Premium badge off ${people}?`, body: 'It no longer shows beside their name. You can give it again at any time.', confirmLabel: 'Remove badge', busyLabel: 'Removing…' }
    : null;

  const copy = asking
    ? asking.action === 'change_role'
      ? { title: `Make ${people} ${ROLE_LABEL[asking.role ?? ''] ?? asking.role}?`, body: 'Their role changes at once.', confirmLabel: 'Change role', busyLabel: 'Changing…', tone: 'default' as const }
      : bulkCopy(asking.action, count)
    : null;

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl bg-[#1a1a2e] px-4 py-2 text-white shadow-lg" data-testid="admin-users-bulk-bar">
      <span className="mr-auto text-sm font-medium">{people} selected</span>
      {tab === 'active' && (
        <>
          <label className="inline-flex items-center">
            <span className="sr-only">Change the role of everyone selected</span>
            <select
              className="min-h-[44px] rounded-lg border border-gray-500 bg-transparent px-2 text-sm text-blue-200"
              value=""
              disabled={working}
              onChange={(e) => { if (e.target.value) setAsking({ action: 'change_role', role: e.target.value }); }}
            >
              <option value="" disabled>Change role</option>
              {roleChoices(isSuperAdmin).map((r) => <option key={r} value={r} className="text-gray-900">{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <button type="button" className={`${BAR_BUTTON} text-amber-200`} disabled={working} onClick={() => setAsking({ action: 'suspend' })}>Suspend</button>
          <button type="button" className={`${BAR_BUTTON} text-red-200`} disabled={working} onClick={() => setAsking({ action: 'ban' })}>Ban</button>
        </>
      )}
      {tab !== 'active' && (
        <button type="button" className={`${BAR_BUTTON} text-emerald-200`} disabled={working} onClick={() => setAsking({ action: 'activate' })}>Reactivate</button>
      )}
      <button type="button" className={`${BAR_BUTTON} text-amber-200`} disabled={working} onClick={() => setBadgeAsk({ badge: 'premium' })}>Give Premium badge</button>
      <button type="button" className={`${BAR_BUTTON} text-gray-200`} disabled={working} onClick={() => setBadgeAsk({ badge: null })}>Remove badge</button>
      <button type="button" className={`${BAR_BUTTON} text-gray-200`} disabled={working} onClick={onClear}>Clear</button>
      <ConfirmDialog
        open={!!copy}
        title={copy?.title ?? ''}
        body={copy?.body ?? ''}
        confirmLabel={copy?.confirmLabel ?? ''}
        busyLabel={copy?.busyLabel}
        tone={copy?.tone ?? 'default'}
        busy={mutation.isPending}
        onConfirm={() => { if (asking) mutation.mutate(asking); }}
        onCancel={() => setAsking(null)}
      />
      <ConfirmDialog
        open={!!badgeCopy}
        title={badgeCopy?.title ?? ''}
        body={badgeCopy?.body ?? ''}
        confirmLabel={badgeCopy?.confirmLabel ?? ''}
        busyLabel={badgeCopy?.busyLabel}
        tone="default"
        busy={badge.pending}
        onConfirm={() => { if (badgeAsk) badge.change({ userIds: selected, badge: badgeAsk.badge, name: null }); }}
        onCancel={() => setBadgeAsk(null)}
      />
    </div>
  );
}
