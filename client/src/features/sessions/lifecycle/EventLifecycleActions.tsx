// ─── The event's status and the steps its organisers may take (Part 2 Task 11; spec 03, 11) ─────────────────────────
// The chip says where the event stands (the server's `lifecycle`, from the shared eventLifecycleOf). The buttons are
// exactly the server's `allowedActions` (the shared eventAllowedActions, which already offers Restore for an archived
// cancelled event): nothing here decides who may do what. Publish, Move back to draft, Archive and Restore act at once
// (each can be undone); Cancel event and Delete permanently ask first, in dialogs portalled to <body>.
import { useState } from 'react';
import { Archive, ArchiveRestore, Ban, Loader2, Send, Trash2, Undo2 } from 'lucide-react';
import type { EventLifecycle, EventLifecycleAction } from '@rsn/shared';
import Badge from '@/components/ui/Badge';
import { lifecycleColor, lifecycleLabel } from '../statusConfig';
import { DANGER_BUTTON, OrganiserCard, PRIMARY_BUTTON, QUIET_BUTTON } from '../organiser-ui';
import { LIFECYCLE_COPY, LIFECYCLE_HINTS, shownActions } from './lifecycle-text';
import { useEventLifecycle } from './useEventLifecycle';
import CancelEventDialog from './CancelEventDialog';
import DeleteEventDialog from './DeleteEventDialog';

interface Props {
  sessionId: string;
  title: string;
  lifecycle: EventLifecycle;
  /** GET /sessions/:id's allowedActions for this viewer. */
  allowedActions: unknown;
  archived: boolean;
  cancelReason?: string | null;
}

const ICONS: Record<EventLifecycleAction, typeof Send> = {
  publish: Send, unpublish: Undo2, archive: Archive, unarchive: ArchiveRestore, cancel: Ban, delete_permanently: Trash2,
};
const LABELS: Record<EventLifecycleAction, string> = {
  publish: LIFECYCLE_COPY.publish,
  unpublish: LIFECYCLE_COPY.unpublish,
  archive: LIFECYCLE_COPY.archive,
  unarchive: LIFECYCLE_COPY.unarchive,
  cancel: LIFECYCLE_COPY.cancel,
  delete_permanently: LIFECYCLE_COPY.deletePermanently,
};
const LOOK: Record<EventLifecycleAction, string> = {
  publish: PRIMARY_BUTTON,
  unpublish: QUIET_BUTTON,
  archive: QUIET_BUTTON,
  unarchive: QUIET_BUTTON,
  cancel: DANGER_BUTTON,
  delete_permanently: DANGER_BUTTON,
};

export default function EventLifecycleActions({ sessionId, title, lifecycle, allowedActions, archived, cancelReason }: Props) {
  const [asking, setAsking] = useState<'cancel' | 'delete_permanently' | null>(null);
  const step = useEventLifecycle(sessionId, { onDone: () => setAsking(null) });
  const actions = shownActions(allowedActions);
  const pressed = step.isPending ? step.variables?.action : null;

  const press = (action: EventLifecycleAction) => {
    if (action === 'cancel' || action === 'delete_permanently') {
      setAsking(action);
      return;
    }
    if (!step.isPending) step.mutate({ action });
  };

  return (
    <OrganiserCard
      testId="event-lifecycle"
      title={LIFECYCLE_COPY.heading}
      hint={LIFECYCLE_HINTS[lifecycle]}
      action={<Badge variant={lifecycleColor(lifecycle)} className="shrink-0 text-sm"><span data-testid="event-lifecycle-chip">{lifecycleLabel(lifecycle)}</span></Badge>}
    >
      {lifecycle === 'cancelled' && cancelReason && (
        <p className="mb-3 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-700 [overflow-wrap:anywhere]">
          <span className="font-medium">{LIFECYCLE_COPY.cancelReasonShown}:</span> {cancelReason}
        </p>
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {archived && actions.includes('unarchive') && (
            <span data-testid="event-archived-inline" className="text-sm text-gray-600">{LIFECYCLE_COPY.archivedInline}</span>
          )}
          {actions.map((action) => {
            const Icon = ICONS[action];
            const busy = pressed === action;
            return (
              <button
                key={action}
                type="button"
                data-testid={`lifecycle-${action}`}
                onClick={() => press(action)}
                disabled={step.isPending}
                aria-busy={busy || undefined}
                className={LOOK[action]}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Icon className="h-4 w-4" aria-hidden="true" />}
                {LABELS[action]}
              </button>
            );
          })}
        </div>
      )}
      <CancelEventDialog
        open={asking === 'cancel'}
        busy={step.isPending}
        onClose={() => setAsking(null)}
        onConfirm={(reason) => step.mutateAsync({ action: 'cancel', reason })}
      />
      <DeleteEventDialog
        open={asking === 'delete_permanently'}
        busy={step.isPending}
        title={title}
        onClose={() => setAsking(null)}
        onConfirm={(confirmTitle) => step.mutateAsync({ action: 'delete_permanently', confirmTitle })}
      />
    </OrganiserCard>
  );
}
