// client/src/features/admin/users/useStatusAction.ts
// One status change at a time on the admin Users page (T2, 1 Nov 2026): it is asked about in a ConfirmDialog, which
// stays open and busy while the server answers, then closes with a toast in a sentence. The row then leaves its tab
// on the list's refetch (the admin:users tag reaches every admin's open list too). Before this, a press that failed
// said nothing and one that worked left the row where it was.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { actionCopy, failureText, RESULT_STATUS, type StatusAction } from './user-status';

export interface AdminUserRowData {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  status: string;
}

export const nameOf = (u: Pick<AdminUserRowData, 'displayName' | 'email'>) => u.displayName?.trim() || u.email;

export function useStatusAction() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [asking, setAsking] = useState<{ user: AdminUserRowData; action: StatusAction } | null>(null);

  const mutation = useMutation({
    mutationFn: ({ user, action }: { user: AdminUserRowData; action: StatusAction }) =>
      action === 'delete'
        ? api.delete(`/users/${user.id}`)
        : api.put(`/users/${user.id}/status`, { status: RESULT_STATUS[action] }),
    onSuccess: (_res, { user, action }) => addToast(actionCopy(action, nameOf(user)).done, 'success'),
    onError: (err) => addToast(failureText(err), 'error'),
    onSettled: () => {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  return {
    asking,
    /** Opens the question for this person and action. */
    ask: (user: AdminUserRowData, action: StatusAction) => { if (!mutation.isPending) setAsking({ user, action }); },
    confirm: () => { if (asking && !mutation.isPending) mutation.mutate(asking); },
    cancel: () => { if (!mutation.isPending) setAsking(null); },
    busy: mutation.isPending,
    /** The person whose change is on its way, so their row shows it. */
    busyUserId: mutation.isPending ? mutation.variables?.user.id ?? null : null,
  };
}
