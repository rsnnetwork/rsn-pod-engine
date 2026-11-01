// REASON's own line on why it suggested two people (30 Oct 2026), in a muted box with the REASON mark,
// so it never reads as something the member wrote (Stefan: "It looks like the sender wrote it"). The
// request card and the introduction card in a conversation both draw it.

import { cn } from '@/lib/utils';

export default function ReasonLineBox({ line, className }: { line: string; className?: string }) {
  return (
    <div
      className={cn('flex items-start gap-2.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-left', className)}
      data-testid="reason-line"
    >
      <img src="/reason-mark-small.png" alt="" className="mt-0.5 h-[18px] w-[24px] shrink-0 object-contain" />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Why REASON suggested this</p>
        <p className="mt-0.5 text-sm text-gray-700 [overflow-wrap:anywhere]">{line}</p>
      </div>
    </div>
  );
}
