// client/src/features/calls/OfflineCallSheet.tsx
// Calling someone who isn't on REASON (11 Nov 2026, Shirley Palmer's RSN 07: "explain the unavailable calling state and
// allow retry or a scheduled call"). Instead of a disabled button, pressing call opens this: Try again (reads their
// presence again and opens the call dialog if they are back), Find a time (the scheduler) and Send a message. It opens the
// same way when the server refuses a ring because they went offline a moment before (CALL_PARTNER_OFFLINE). On a phone
// it is the REASON bottom sheet, its three actions 44px tall and stacked.
import Sheet from '@/features/reason/ui/Sheet';
import { FIND_A_TIME, OFFLINE_BODY, SEND_A_MESSAGE, TRY_AGAIN, offlineTitle } from './presence-words';

const ACTION = 'inline-flex min-h-[44px] w-full items-center justify-center rounded-[11px] px-4 text-[14px] font-bold sm:w-auto';

interface Props {
  open: boolean;
  name: string | null | undefined;
  onClose: () => void;
  onTryAgain: () => void;
  /** Absent where no scheduler can open. */
  onFindATime?: () => void;
  onSendMessage: () => void;
  /** Try again is reading their presence. */
  trying: boolean;
}

export default function OfflineCallSheet({ open, name, onClose, onTryAgain, onFindATime, onSendMessage, trying }: Props) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={offlineTitle(name)}
      footer={(
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end" data-testid="offline-call-actions">
          <button type="button" onClick={onSendMessage} className={`${ACTION} border border-reason-line bg-white`}>
            {SEND_A_MESSAGE}
          </button>
          {onFindATime && (
            <button type="button" onClick={onFindATime} className={`${ACTION} border border-reason-line bg-white`}>
              {FIND_A_TIME}
            </button>
          )}
          <button
            type="button"
            onClick={onTryAgain}
            aria-busy={trying || undefined}
            disabled={trying}
            className={`${ACTION} bg-reason-red text-white enabled:hover:bg-reason-red-hover disabled:opacity-70`}
          >
            {trying ? 'Checking…' : TRY_AGAIN}
          </button>
        </div>
      )}
    >
      <p className="py-2 text-[14px] text-reason-muted" data-testid="offline-call-body">{OFFLINE_BODY}</p>
    </Sheet>
  );
}
