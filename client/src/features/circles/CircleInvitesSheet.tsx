// ─── A circle's invitations, for the people who run it (Shirley pilot S2, 11 Nov 2026; brief RSN 04) ────────────────
// Waiting, accepted and declined invitations, newest first (GET /invites/circle/:circleId). A waiting one can be
// withdrawn (it asks first; DELETE /invites/:id). The address shows in full only on the invites the viewer sent; the
// server masks the rest. The list follows circle:<id>:invites, so an invite sent, accepted, declined or withdrawn
// anywhere changes it without a reload.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CircleInviteRow } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import { INVITATIONS, INVITATIONS_EMPTY, INVITE_STATE_LABEL, circleInviteEntities } from './circle-admin';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

interface Props { circleId: string; circleName: string; onClose: () => void; onInvite: () => void }

const who = (row: CircleInviteRow) => row.invitee ?? (row.isLink ? 'A shared link' : 'Someone');

export default function CircleInvitesSheet({ circleId, circleName, onClose, onInvite }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const list = useQuery<CircleInviteRow[]>({
    queryKey: ['circle-invites', circleId],
    queryFn: () => api.get(`/invites/circle/${circleId}`).then((r) => r.data.data ?? []),
    meta: { entities: circleInviteEntities(circleId) },
  });
  const withdraw = useMutation({
    networkMode: 'always',
    mutationFn: (inviteId: string) => api.delete(`/invites/${inviteId}`),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['circle-invites', circleId] }), refreshCircle(qc, circleId)]);
      addToast('Invitation withdrawn.', 'success');
    },
    onError: async (err) => {
      addToast(circleErrorSentence(err, 'That invitation could not be withdrawn. Try again.'), 'error');
      await qc.invalidateQueries({ queryKey: ['circle-invites', circleId] });
    },
  });

  const confirmWithdraw = async (row: CircleInviteRow) => {
    if (withdraw.isPending) return;
    if (!(await ask({
      title: 'Withdraw this invitation?',
      body: `${who(row)} will no longer be able to join ${circleName} with it.`,
      confirmLabel: 'Withdraw',
      tone: 'danger',
    }))) return;
    withdraw.mutate(row.id);
  };

  const rows = list.data ?? [];
  return (
    <Sheet open onClose={onClose} title={INVITATIONS}>
      <div className="mt-2 space-y-2" data-testid="circle-invites">
        {list.isPending && (
          <div className="space-y-2" aria-label="Loading invitations"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
        )}
        {list.isError && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-[14px] text-red-700">
            {circleErrorSentence(list.error, 'The invitations could not be loaded.')}
            <Button type="button" variant="ghost" onClick={() => void list.refetch()} className="ml-2 min-h-[44px]">Try again</Button>
          </div>
        )}
        {list.isSuccess && rows.length === 0 && (
          <div className="rounded-xl border border-gray-200 p-4 text-center">
            <p className="text-[14px] text-gray-600">{INVITATIONS_EMPTY}</p>
            <Button type="button" onClick={onInvite} className="mt-3 min-h-[44px]">Invite people</Button>
          </div>
        )}
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-3 rounded-xl border border-gray-200 p-3" data-testid={`circle-invite-${row.id}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-gray-900">{who(row)}</p>
              <p className="text-[12px] text-gray-500">
                {INVITE_STATE_LABEL[row.state]}
                {row.inviterName ? ` · invited by ${row.sentByMe ? 'you' : row.inviterName}` : ''}
              </p>
            </div>
            {row.state === 'pending' && (
              <button
                type="button"
                onClick={() => void confirmWithdraw(row)}
                disabled={withdraw.isPending}
                className="min-h-[44px] shrink-0 rounded-lg border border-gray-200 px-3 text-[13px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                data-testid={`circle-invite-withdraw-${row.id}`}
              >
                {withdraw.isPending && withdraw.variables === row.id ? 'Withdrawing…' : 'Withdraw'}
              </button>
            )}
          </div>
        ))}
      </div>
      {confirmDialog}
    </Sheet>
  );
}
