// ─── The member's own asks for a new circle, on the Circles page (Ben field test, 13 Nov 2026) ─────────────────────
// Each ask says where it stands: waiting (with Withdraw), approved (with a link to the circle), not approved (with the
// reason when one was given) or withdrawn. Shown only when the member has asked for one; it follows their own tag,
// so an admin's answer appears without a refresh.
import { Link } from 'react-router-dom';
import type { CircleCreationRequest, CircleCreationRequestStatus } from '@rsn/shared';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import { REQUEST_STATUS_LABEL } from './circle-logic';
import { circleErrorSentence } from './useCircleActions';
import { useMyCircleRequests, useWithdrawCircleRequest } from './useCircleRequests';

const CHIP: Record<CircleCreationRequestStatus, string> = {
  pending: 'bg-amber-50 text-amber-700',
  approved: 'bg-emerald-50 text-emerald-700',
  declined: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-500',
};

export default function MyCircleRequests({ userId }: { userId: string | undefined }) {
  const { data, isError, refetch } = useMyCircleRequests(userId);
  const withdraw = useWithdrawCircleRequest();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();

  if (isError) {
    return (
      <Card className="!p-4" data-testid="my-circle-requests-error">
        <p className="text-sm text-gray-600">Your circle requests could not be loaded.</p>
        <Button variant="ghost" onClick={() => void refetch()} className="mt-2 min-h-[44px]">Try again</Button>
      </Card>
    );
  }
  if (!data || data.length === 0) return null;

  const press = async (r: CircleCreationRequest) => {
    if (withdraw.isPending) return;
    if (!(await ask({ title: `Withdraw your request for ${r.name}?`, body: 'You can ask again later.', confirmLabel: 'Withdraw', tone: 'danger' }))) return;
    withdraw.mutate(r.id, {
      onSuccess: () => addToast('Your request was withdrawn.', 'success'),
      onError: (err) => addToast(circleErrorSentence(err, 'Your request could not be withdrawn. Try again.'), 'error'),
    });
  };

  return (
    <section className="space-y-2" data-testid="my-circle-requests">
      <h2 className="text-sm font-semibold text-gray-700">Your circle requests</h2>
      {data.map((r) => (
        <Card key={r.id} className="!p-4" data-testid={`my-circle-request-${r.id}`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-gray-900 [overflow-wrap:anywhere]">{r.name}</p>
              <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[12px] font-medium ${CHIP[r.status]}`} data-testid="my-circle-request-status">
                {REQUEST_STATUS_LABEL[r.status]}
              </span>
              {r.status === 'declined' && r.declineReason && (
                <p className="mt-1 text-[13px] text-gray-600 [overflow-wrap:anywhere]">{r.declineReason}</p>
              )}
            </div>
            {r.status === 'pending' && (
              <Button variant="outline" size="sm" onClick={() => void press(r)} disabled={withdraw.isPending} className="min-h-[44px] shrink-0" data-testid="my-circle-request-withdraw">
                Withdraw
              </Button>
            )}
            {r.status === 'approved' && r.circleId && (
              <Link to={`/circles/${r.circleId}`} className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg px-3 text-sm font-medium text-rsn-red hover:bg-rsn-red/5" data-testid="my-circle-request-open">
                Open circle
              </Link>
            )}
          </div>
        </Card>
      ))}
      {confirmDialog}
    </section>
  );
}
