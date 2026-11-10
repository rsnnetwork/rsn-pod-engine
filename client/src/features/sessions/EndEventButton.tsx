// End event, for a super admin, on an event that is live (10 Nov 2026, F7, spec 10/07).
//
// A member's event left running had no way to be ended by the platform: only its host could. The super admin's
// override is the same POST /sessions/:id/host/end the host's controls use; the server completes the event and its
// completed fan-out moves every page that shows it to Ended (the event page, the host's live page, the lists), so
// nothing here edits a cache. The admins' list and this event are also refetched for the person who pressed it.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { useConfirm } from '@/hooks/useConfirm';
import { cn } from '@/lib/utils';

interface EndEventButtonProps {
  sessionId: string;
  className?: string;
}

export default function EndEventButton({ sessionId, className }: EndEventButtonProps) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  const { ask, confirmDialog } = useConfirm();

  const endEvent = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/host/end`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['admin-sessions'] });
      addToast('Event ended', 'success');
    },
    onError: () => addToast('Could not end the event. Please try again.', 'error'),
  });

  const onClick = async () => {
    if (endEvent.isPending) return;
    const sure = await ask({
      title: 'End this event for everyone?',
      body: 'Everyone in it leaves the event and it moves to Ended. This cannot be undone.',
      confirmLabel: 'End event',
      cancelLabel: 'Keep it running',
      tone: 'danger',
    });
    if (sure) endEvent.mutate();
  };

  return (
    <>
      <button
        type="button"
        data-testid="end-event"
        onClick={onClick}
        disabled={endEvent.isPending}
        className={cn(
          'min-h-[44px] px-4 rounded-xl border border-red-200 bg-white hover:bg-red-50 inline-flex items-center justify-center gap-2 text-sm font-semibold text-red-600 hover:text-red-700 transition-colors disabled:opacity-60 whitespace-nowrap',
          className,
        )}
      >
        <Square className="h-4 w-4 shrink-0" aria-hidden="true" />
        {endEvent.isPending ? 'Ending…' : 'End event'}
      </button>
      {confirmDialog}
    </>
  );
}
