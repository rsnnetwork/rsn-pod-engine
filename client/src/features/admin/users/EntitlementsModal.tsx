// client/src/features/admin/users/EntitlementsModal.tsx
// A member's limits (pods they may own, events a month, invites a day, hosting and pod creation), moved out of the
// Users page unchanged, with a sentence when it cannot be read or saved.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { failureText } from './user-status';
import { nameOf, type AdminUserRowData } from './useStatusAction';

interface Entitlements {
  maxPodsOwned: number; maxSessionsPerMonth: number; maxInvitesPerDay: number; canHostSessions: boolean; canCreatePods: boolean;
}

const DEFAULTS: Entitlements = { maxPodsOwned: 1, maxSessionsPerMonth: 5, maxInvitesPerDay: 10, canHostSessions: false, canCreatePods: false };
const FIELD = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]';

export default function EntitlementsModal({ user, onClose }: { user: AdminUserRowData; onClose: () => void }) {
  const read = useQuery({
    queryKey: ['admin-user-entitlements', user.id],
    queryFn: () => api.get(`/admin/users/${user.id}/entitlements`).then((r) => r.data.data as Entitlements),
    meta: { entities: [E.user(user.id), E.adminUsers] },
    retry: false,
  });
  return (
    <Modal open onClose={onClose} title={`Limits for ${nameOf(user)}`}>
      {read.isPending
        ? <p className="py-6 text-center text-sm text-gray-500">Reading their limits…</p>
        // A member with no limits saved yet (or a read that fails) starts from the defaults, as before.
        : <LimitsForm key={user.id} user={user} initial={read.data ?? DEFAULTS} onClose={onClose} />}
    </Modal>
  );
}

function LimitsForm({ user, initial, onClose }: { user: AdminUserRowData; initial: Entitlements; onClose: () => void }) {
  const addToast = useToastStore((s) => s.addToast);
  const [limits, setLimits] = useState<Entitlements>(initial);

  const save = useMutation({
    mutationFn: () => api.put(`/admin/users/${user.id}/entitlements`, limits),
    onSuccess: () => { addToast(`${nameOf(user)}'s limits are saved.`, 'success'); onClose(); },
    onError: (err) => addToast(failureText(err), 'error'),
  });

  const set = <K extends keyof Entitlements>(key: K, value: Entitlements[K]) => setLimits((p) => ({ ...p, [key]: value }));
  const number = (key: 'maxPodsOwned' | 'maxSessionsPerMonth' | 'maxInvitesPerDay', label: string, max: number) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      <input type="number" min={0} max={max} value={limits[key]} onChange={(e) => set(key, parseInt(e.target.value, 10) || 0)} className={FIELD} />
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {number('maxPodsOwned', 'Pods they may own', 100)}
        {number('maxSessionsPerMonth', 'Events a month', 500)}
        {number('maxInvitesPerDay', 'Invites a day', 1000)}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={limits.canHostSessions} onChange={(e) => set('canHostSessions', e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red" />
          Can host events
        </label>
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={limits.canCreatePods} onChange={(e) => set('canCreatePods', e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-rsn-red focus:ring-rsn-red" />
          Can create pods
        </label>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} isLoading={save.isPending}>Save limits</Button>
      </div>
    </div>
  );
}
