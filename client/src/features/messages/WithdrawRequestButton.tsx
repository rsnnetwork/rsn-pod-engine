// "Withdraw request", drawn beside "Request sent" wherever a member has asked to meet someone (10 Nov 2026). A
// secondary button: withdrawing is undone by asking again, so it asks for no confirmation. Disabled while the
// withdrawal is on its way, on every surface showing this person (useWithdrawRequest).
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWithdrawRequest } from './useWithdrawRequest';

interface Props {
  userId: string;
  /** The request's id when the page already has it; otherwise it is looked up from the person. */
  requestId?: string | null;
  className?: string;
  /** "Withdraw" under 768px, where the row is tight (the profile's bar on a phone); the button's name stays the full one. */
  shortLabel?: boolean;
}

export default function WithdrawRequestButton({ userId, requestId = null, className, shortLabel = false }: Props) {
  const { withdraw, busy } = useWithdrawRequest(userId, requestId);
  return (
    <button
      type="button"
      onClick={withdraw}
      disabled={busy}
      aria-label={shortLabel ? 'Withdraw request' : undefined}
      data-testid={`withdraw-request-${userId}`}
      className={cn(
        'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-[11px] border border-gray-300 bg-white px-3 text-[13px] font-bold text-[#2d3440] transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {busy ? 'Withdrawing…' : shortLabel ? <>Withdraw<span className="hidden md:inline">&nbsp;request</span></> : 'Withdraw request'}
    </button>
  );
}
