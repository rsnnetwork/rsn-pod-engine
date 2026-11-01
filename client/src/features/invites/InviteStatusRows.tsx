// ─── The Invitations card's three lists: Invited, Declined and the shareable links (split out 1 Nov 2026) ─────────
//
// Drawn by InviteStatusList.tsx, which holds the reads and the actions. Invited offers Remind and Withdraw on each row
// and Remind all above them; while Remind all runs it says how far it is ("Sending 3 of 12…"), a pod's offers Stop,
// and no row's Remind can be pressed meanwhile (P1 item 34). A member is named, never addressed (P1 item 27).
import { Link2, Send, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SHAREABLE_LINK, dayOf, personName, remindingProgress, type InviteListRow } from './invite-status';

export const ROW_BUTTON = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';

/** How far a running Remind all is; null while it is not running or runs as one request (an event's). */
export interface RemindProgress { done: number; total: number }

interface InvitedProps {
  rows: InviteListRow[];
  remindAllBusy: boolean;
  progress: RemindProgress | null;
  onRemindAll: () => void;
  /** Offered while a pod's Remind all runs: no further reminder starts. */
  onStop?: () => void;
  remindingId: string | null;
  withdrawingId: string | null;
  onRemind: (inviteId: string) => void;
  onWithdraw: (inviteId: string) => void;
}

export function InvitedSection({
  rows, remindAllBusy, progress, onRemindAll, onStop, remindingId, withdrawingId, onRemind, onWithdraw,
}: InvitedProps) {
  const remindAllLabel = !remindAllBusy
    ? `Remind all (${rows.length})`
    : progress ? remindingProgress(progress.done, progress.total) : 'Reminding…';
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-700">Invited ({rows.length})</h3>
        {rows.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { if (!remindAllBusy) onRemindAll(); }}
              disabled={remindAllBusy}
              aria-live="polite"
              className={cn(ROW_BUTTON, 'border-purple-200 bg-white text-purple-700 hover:bg-purple-50')}
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {remindAllLabel}
            </button>
            {remindAllBusy && onStop && (
              <button type="button" onClick={onStop} className={cn(ROW_BUTTON, 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50')}>
                Stop
              </button>
            )}
          </div>
        )}
      </div>
      <ul className="mt-2 grid grid-cols-1 gap-2">
        {rows.map((row) => {
          const reminding = remindingId === row.id;
          return (
            <li key={row.id} data-testid={`invite-row-${row.id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-gray-100 p-3">
              <div className="min-w-0 flex-[1_1_11rem]">
                <p className="truncate text-sm font-medium text-gray-800">{personName(row)}</p>
                <p className="text-xs text-gray-500">Invited {dayOf(row.createdAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => { if (!reminding && !remindAllBusy) onRemind(row.id); }}
                  disabled={reminding || remindAllBusy}
                  className={cn(ROW_BUTTON, 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" /> {reminding ? 'Sending…' : 'Remind'}
                </button>
                <button
                  type="button"
                  onClick={() => onWithdraw(row.id)}
                  disabled={withdrawingId === row.id}
                  className={cn(ROW_BUTTON, 'border-red-200 bg-white text-red-600 hover:bg-red-50')}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Withdraw
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DeclinedSection({ rows }: { rows: InviteListRow[] }) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-gray-700">Declined ({rows.length})</h3>
      <ul className="mt-2 grid grid-cols-1 gap-2">
        {rows.map((row) => (
          <li key={row.id} data-testid={`invite-row-${row.id}`} className="min-w-0 rounded-xl bg-gray-50 p-3">
            <p className="truncate text-sm font-medium text-gray-700">{personName(row)}</p>
            <p className="text-xs text-gray-500">Declined {row.declinedAt ? dayOf(row.declinedAt) : ''}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LinksSection({ rows, withdrawingId, onWithdraw }: {
  rows: InviteListRow[];
  withdrawingId: string | null;
  onWithdraw: (inviteId: string) => void;
}) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-gray-700">Shareable links ({rows.length})</h3>
      <ul className="mt-2 grid grid-cols-1 gap-2">
        {rows.map((row) => (
          <li key={row.id} data-testid={`invite-row-${row.id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-gray-100 p-3">
            <div className="min-w-0 flex-[1_1_11rem]">
              <p className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
                <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {SHAREABLE_LINK}
              </p>
              <p className="text-xs text-gray-500">
                Made {dayOf(row.createdAt)}
                {row.maxUses !== undefined && row.useCount !== undefined ? ` · used ${row.useCount} of ${row.maxUses}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onWithdraw(row.id)}
              disabled={withdrawingId === row.id}
              className={cn(ROW_BUTTON, 'border-red-200 bg-white text-red-600 hover:bg-red-50')}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Withdraw
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
