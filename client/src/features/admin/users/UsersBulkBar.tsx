// client/src/features/admin/users/UsersBulkBar.tsx
// What the selected rows can have done to them together: on Active a role, Suspend or Ban; on the other tabs
// Reactivate. Each asks first (ConfirmDialog, busy while the server answers) and says how it went in a toast. A role
// change that grants or removes admin also needs "Confirm it's you" (ReauthDialog, over the busy question).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { touchesAdminRole } from '@rsn/shared';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import ReauthDialog from '@/features/settings/ReauthDialog';
import { useReauth } from '@/features/settings/useReauth';
import { isReauthCancelled, withProof } from '@/features/settings/reauth';
import { ROLE_LABEL, bulkCopy, failureText, roleChoices, type AccountStatus } from './user-status';

type BulkAction = 'suspend' | 'ban' | 'activate' | 'change_role';

interface Props { selected: string[]; tab: AccountStatus; isSuperAdmin: boolean; onDone: () => void; onClear: () => void }

const BAR_BUTTON = 'inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium hover:bg-white/10 disabled:opacity-50';

export default function UsersBulkBar({ selected, tab, isSuperAdmin, onDone, onClear }: Props) {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [asking, setAsking] = useState<{ action: BulkAction; role?: string } | null>(null);
  const count = selected.length;
  const people = count === 1 ? '1 person' : `${count} people`;

  // A role change to admin or super_admin asks "Confirm it's you" first; one the server answers REAUTH_REQUIRED (an admin
  // among the people selected) asks then. Either way the change is sent again with the proof in its body (Part 3 Task 7).
  const reauth = useReauth();
  const mutation = useMutation({
    mutationFn: ({ action, role }: { action: BulkAction; role?: string }) =>
      reauth.withReauth('admin_role', action === 'change_role' && touchesAdminRole([], role), (reauthToken) =>
        api.post('/admin/users/bulk-action', withProof({ userIds: selected, action, value: role }, reauthToken))),
    onSuccess: (_res, { action, role }) => {
      addToast(action === 'change_role' ? `${people} are now ${ROLE_LABEL[role ?? ''] ?? role}.` : bulkCopy(action, count).done, 'success');
      onDone();
    },
    onError: (err) => { if (!isReauthCancelled(err)) addToast(failureText(err), 'error'); },
    onSettled: () => {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

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
              disabled={mutation.isPending}
              onChange={(e) => { if (e.target.value) setAsking({ action: 'change_role', role: e.target.value }); }}
            >
              <option value="" disabled>Change role</option>
              {roleChoices(isSuperAdmin).map((r) => <option key={r} value={r} className="text-gray-900">{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <button type="button" className={`${BAR_BUTTON} text-amber-200`} disabled={mutation.isPending} onClick={() => setAsking({ action: 'suspend' })}>Suspend</button>
          <button type="button" className={`${BAR_BUTTON} text-red-200`} disabled={mutation.isPending} onClick={() => setAsking({ action: 'ban' })}>Ban</button>
        </>
      )}
      {tab !== 'active' && (
        <button type="button" className={`${BAR_BUTTON} text-emerald-200`} disabled={mutation.isPending} onClick={() => setAsking({ action: 'activate' })}>Reactivate</button>
      )}
      <button type="button" className={`${BAR_BUTTON} text-gray-200`} disabled={mutation.isPending} onClick={onClear}>Clear</button>
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
      <ReauthDialog {...reauth.dialog} />
    </div>
  );
}
