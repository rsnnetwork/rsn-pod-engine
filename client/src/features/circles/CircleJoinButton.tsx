// ─── A circle's one membership button (T14, 1 Nov 2026) ──────────────────────────────────────────────────────────
// Join (open), Ask to join (closed), Requested · Cancel (waiting) or Leave, on the circles list and the circle page.
// Leaving asks first. While its call is on its way the button says so and takes no second tap.
// Shirley pilot S2: the owner has no Leave (the server refuses it too); a line says how to hand the circle over first.
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import { joinButton, type CircleSummary } from './circle-logic';
import { OWNER_STAYS, ownsCircle } from './circle-admin';
import { useCircleMembership } from './useCircleActions';

const BUSY: Record<string, string> = { join: 'Joining…', request: 'Asking…', cancel: 'Withdrawing…', leave: 'Leaving…' };

export default function CircleJoinButton({ circle, size }: { circle: CircleSummary; size?: 'sm' }) {
  const membership = useCircleMembership();
  const { ask, confirmDialog } = useConfirm();
  const { action, label } = joinButton(circle);
  const busy = membership.isPending && membership.variables?.circleId === circle.id;

  if (ownsCircle(circle)) {
    return (
      <span className="inline-flex min-h-[44px] items-center rounded-lg bg-rsn-red-light px-3 text-sm font-medium text-rsn-red" title={OWNER_STAYS} data-testid={`circle-owner-${circle.id}`}>
        You own this circle
      </span>
    );
  }

  const press = async () => {
    if (membership.isPending) return;
    if (action === 'leave' && !(await ask({
      title: `Leave ${circle.name}?`,
      body: circle.joinPolicy === 'closed' ? 'It is closed, so to come back you ask to join again.' : 'You can join again at any time.',
      confirmLabel: 'Leave',
      tone: 'danger',
    }))) return;
    membership.mutate({ circleId: circle.id, name: circle.name, action });
  };

  return (
    <>
      <Button
        size={size}
        variant={action === 'leave' ? 'ghost' : action === 'cancel' ? 'outline' : 'primary'}
        onClick={() => void press()}
        disabled={busy}
        data-testid={`circle-join-${circle.id}`}
        data-action={action}
        className="min-h-[44px] shrink-0"
      >
        {busy ? BUSY[action] : label}
      </Button>
      {confirmDialog}
    </>
  );
}
