// client/src/features/sessions/EventAccessActions.tsx
// T11 (1 Nov 2026; L17) — what the event page offers someone who is not registered, read from the server's
// `session.access` (never guessed from the pod): Register, Request to join (a short sheet with an optional
// message, then "Request sent · Withdraw"), or the private notice. The server has the last word on each press.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Send, UserPlus } from 'lucide-react';
import type { EventAccessMode, EventJoinRequestStatus, EventVisibility } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

/** The `access` block GET /sessions/:id carries (T11). Absent on a server before T11: the page then offers Register. */
export interface EventAccess {
  visibility: EventVisibility | null;
  mode: EventAccessMode;
  myRequest: EventJoinRequestStatus | null;
  autoRegister: boolean;
  canManageRequests: boolean;
}

export const ACCESS_COPY = {
  privateTitle: 'This event is private',
  privateWho: "It is for its pod's members and the people the host invites.",
  privateNotice: 'This event is private. It is for its pod\'s members and the people the host invites.',
  requestTitle: 'Request to join',
  requestBody: 'The host approves each place. You can add a short note for them.',
  messageLabel: 'A note for the host (optional)',
  send: 'Send request',
  sent: 'Request sent',
  withdraw: 'Withdraw',
  declined: 'The host has declined your request for this event.',
  sentToast: 'Request sent. You will hear when the host answers.',
  withdrawnToast: 'Your request was withdrawn.',
  fallback: 'That did not go through. Please try again.',
};

const MESSAGE_MAX = 500;

function serverSentence(err: unknown): string {
  const message = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
  return message || ACCESS_COPY.fallback;
}

interface Props {
  sessionId: string;
  access: EventAccess | undefined;
  /** "Register" before the event, "Join Late" while it runs. */
  registerLabel: string;
  onRegister: () => void;
  registering: boolean;
}

export default function EventAccessActions({ sessionId, access, registerLabel, onRegister, registering }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['session', sessionId] });

  const ask = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/requests`, message.trim() ? { message: message.trim() } : {}),
    onSuccess: () => {
      setSheetOpen(false);
      setMessage('');
      addToast(ACCESS_COPY.sentToast, 'success');
      refresh();
    },
    onError: (err) => addToast(serverSentence(err), 'error'),
  });

  const withdraw = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}/requests/mine`),
    onSuccess: () => {
      addToast(ACCESS_COPY.withdrawnToast, 'info');
      refresh();
    },
    onError: (err) => addToast(serverSentence(err), 'error'),
  });

  const mode = access?.mode ?? 'register';

  if (mode === 'private') {
    return (
      <div data-testid="event-private-notice" className="flex items-start gap-2 px-4 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-700 text-sm">
        <Lock className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <span>{ACCESS_COPY.privateNotice}</span>
      </div>
    );
  }

  if (mode === 'request') {
    if (access?.myRequest === 'declined') {
      return (
        <p data-testid="event-request-declined" className="px-4 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-700 text-sm">
          {ACCESS_COPY.declined}
        </p>
      );
    }
    if (access?.myRequest === 'pending') {
      return (
        <div data-testid="event-request-sent" className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 px-4 min-h-[44px] rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            <Send className="h-4 w-4" /> {ACCESS_COPY.sent}
          </span>
          <Button variant="ghost" className="min-h-[44px]" onClick={() => withdraw.mutate()} isLoading={withdraw.isPending}>
            {ACCESS_COPY.withdraw}
          </Button>
        </div>
      );
    }
    return (
      <>
        <Button data-testid="event-request-open" onClick={() => setSheetOpen(true)} className="btn-glow min-h-[44px]">
          <Send className="h-4 w-4 mr-2" /> {ACCESS_COPY.requestTitle}
        </Button>
        <Sheet
          open={sheetOpen}
          onClose={() => { if (!ask.isPending) setSheetOpen(false); }}
          title={ACCESS_COPY.requestTitle}
          footer={(
            <div className="flex justify-end gap-3">
              <Button variant="ghost" className="min-h-[44px]" onClick={() => setSheetOpen(false)} disabled={ask.isPending}>Cancel</Button>
              <Button data-testid="event-request-send" className="min-h-[44px]" onClick={() => ask.mutate()} isLoading={ask.isPending}>
                {ACCESS_COPY.send}
              </Button>
            </div>
          )}
        >
          <p className="text-sm text-gray-600 mb-3">{ACCESS_COPY.requestBody}</p>
          <label htmlFor="event-request-message" className="block text-sm font-medium text-gray-800 mb-1">{ACCESS_COPY.messageLabel}</label>
          <textarea
            id="event-request-message"
            data-testid="event-request-message"
            value={message}
            maxLength={MESSAGE_MAX}
            rows={3}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full rounded-xl border border-gray-200 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-rsn-red/30"
          />
          <p className="text-xs text-gray-400 mt-1 text-right">{message.length}/{MESSAGE_MAX}</p>
        </Sheet>
      </>
    );
  }

  return (
    <Button data-testid="event-register" onClick={onRegister} isLoading={registering} className="btn-glow min-h-[44px]">
      <UserPlus className="h-4 w-4 mr-2" /> {registerLabel}
    </Button>
  );
}
