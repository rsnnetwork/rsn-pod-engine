import { useNavigate } from 'react-router-dom';
import { CheckCircle, Loader2, X } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { bellRequestView, type BellRequestView } from '@/features/messages/request-answer';
import { useRequestAnswer } from '@/features/messages/useRequestAnswer';
import { canActOnInvite, inviteStatusLabel, timeAgo, type Notification } from './notification-logic';

// One notification, the same in the bell and on the notifications page (30 Oct 2026 review, item 4.5): its title, its
// words, how long ago, and what can be done with it here. An invite still waiting offers Accept and Decline; an invite
// with its answer says Accepted, Declined or Expired. A meeting request is drawn from what the server says
// (bellRequestView): Accept and Decline while it waits, "Accepted" or "Declined" once answered (here or anywhere), and
// "No longer available" once it is gone (a closed account, a withdrawal, a block), with nothing to press (P11).

export default function NotificationItem({ n, title, onOpen, acting, onAcceptInvite, onDeclineInvite, onLeave, isRead }: {
  n: Notification;
  /** What the row says on top: the notification's own title, or the page's "Shradha sent you 3 messages". */
  title?: string;
  onOpen: () => void;
  acting: boolean;
  onAcceptInvite: () => void;
  onDeclineInvite: () => void;
  /** Runs before an accepted request moves the page on (the bell closes its panel). */
  onLeave: () => void;
  /** Whether the row reads as read (the page's run of messages is read only when all of them are). */
  isRead?: boolean;
}) {
  const read = isRead ?? n.isRead;
  const statusLabel = inviteStatusLabel(n);
  const request = bellRequestView(n);
  return (
    <div data-testid="notification-row" data-read={read ? 'yes' : 'no'} className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors ${!read ? 'bg-blue-50/40' : ''}`}>
      <button onClick={onOpen} className="min-h-[44px] w-full text-left hover:opacity-80 cursor-pointer">
        <div className="flex items-start gap-2">
          {!read && <div className="mt-1.5 w-2 h-2 rounded-full bg-rsn-red shrink-0" aria-label="Unread" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className={`text-sm leading-snug break-words ${!read ? 'font-medium text-gray-800' : 'text-gray-600'}`}>{title ?? n.title}</p>
              {statusLabel && <span className={`text-[10px] font-medium shrink-0 ${statusLabel.color}`}>{statusLabel.text}</span>}
            </div>
            {/* pre-line: a meeting request's note and "Why REASON suggested this:" arrive as two paragraphs, and were run
                together on one line (5 Oct 2026). line-clamp-6: a body made of many single line breaks would otherwise make
                one entry thousands of pixels tall and push its own Accept and Decline out of reach. The whole text is one
                tap away, on the page the entry opens. */}
            {n.body && <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-line break-words line-clamp-6">{n.body}</p>}
            <p className="text-[10px] text-gray-500 mt-1">{timeAgo(n.createdAt)}</p>
          </div>
        </div>
      </button>

      {/* Inline Accept / Decline for PENDING invites only. Both Accept buttons are REASON's green darkened until a white
          label reads on it (green-fill is 4.60:1, 5.80:1 hovered). Not the brand red: red reads as the opposite of accepting. */}
      {canActOnInvite(n) && (
        <div className="flex items-center gap-2 mt-2 ml-4">
          <button
            onClick={onAcceptInvite}
            disabled={acting}
            className="flex min-h-[44px] items-center gap-1 px-4 text-xs font-medium rounded-full bg-reason-green-fill text-white hover:bg-reason-green-fill-hover disabled:opacity-50 transition-colors"
          >
            {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
            Accept
          </button>
          <button
            onClick={onDeclineInvite}
            disabled={acting}
            className="flex min-h-[44px] items-center gap-1 px-4 text-xs font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            <X className="h-3 w-3" />
            Decline
          </button>
        </div>
      )}
      {/* Meeting request: what the server says it is, answered here; accept lands in the conversation. */}
      {request && <RequestActions n={n} view={request} onLeave={onLeave} />}
    </div>
  );
}

/**
 * A meeting request's actions (4 Sep 2026, Ali: "accept or reject inside the bell, and once accepted it should take me
 * directly into the chat"). Waiting: Accept and Decline. Answered, here or anywhere else: "Accepted" or "Declined", from
 * the server, with nothing left to press; gone: "No longer available". Busy while ANY surface is answering this request.
 */
function RequestActions({ n, view, onLeave }: { n: Notification; view: BellRequestView; onLeave: () => void }) {
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  // Accepting again what is already accepted is a 200 with the same conversation, so a stale row lands in the thread
  // too. The other answer given elsewhere is a 409: the hook says so and the row redraws.
  const { answer, busy: isActing, answering } = useRequestAnswer(view.requestId, {
    onAccepted: (result) => {
      onLeave();
      navigate(result.conversationId ? `/messages/${result.conversationId}` : '/messages');
    },
    onDeclined: () => addToast('Request declined', 'info'),
  });

  if (view.canAnswer) {
    return (
      <div className="flex items-center gap-2 mt-2 ml-4" data-testid={`poke-actions-${n.id}`}>
        <button
          onClick={() => answer('accept')}
          disabled={isActing}
          className="flex min-h-[44px] items-center gap-1 rounded-full bg-reason-green-fill px-4 text-xs font-medium text-white transition-colors hover:bg-reason-green-fill-hover disabled:opacity-50"
        >
          {answering === 'accept' ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
          Accept
        </button>
        <button
          onClick={() => answer('decline')}
          disabled={isActing}
          className="flex min-h-[44px] items-center gap-1 rounded-full bg-gray-100 px-4 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200 disabled:opacity-50"
        >
          {answering === 'decline' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          Decline
        </button>
      </div>
    );
  }
  if (!view.label) return null;
  return (
    <p data-testid={`request-label-${n.id}`} className={`ml-4 mt-1 text-[10px] font-medium ${view.label === 'Accepted' ? 'text-emerald-700' : 'text-gray-500'}`}>
      {view.label}
    </p>
  );
}
