// ─── A circle's one membership button (T14, 1 Nov 2026) ──────────────────────────────────────────────────────────
// Join (open), Ask to join (closed), Requested · Cancel (waiting) or Leave, on the circles list and the circle page.
// Leaving asks first. While its call is on its way the button says so and takes no second tap.
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import { joinButton, type CircleSummary } from './circle-logic';
import { useCircleMembership } from './useCircleActions';

const BUSY: Record<string, string> = { join: 'Joining…', request: 'Asking…', cancel: 'Withdrawing…', leave: 'Leaving…' };

export default function CircleJoinButton({ circle, size }: { circle: CircleSummary; size?: 'sm' }) {
  const membership = useCircleMembership();
  const { ask, confirmDialog } = useConfirm();
  const { action, label } = joinButton(circle);
  const busy = membership.isPending && membership.variables?.circleId === circle.id;

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
