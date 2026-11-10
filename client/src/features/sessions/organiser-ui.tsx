// ─── The organiser's event settings: one look for every card (Part 2 Task 11) ───────────────────────────────────────
// The event page's cards (Card, the page's grey fields, 44px controls) and the three states every list has: loading
// (a skeleton the size of a row, so nothing jumps), an error with Try again, and an empty sentence.
import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import Card from '@/components/ui/Card';
import { cn } from '@/lib/utils';

/** A field: 44px tall, never wider than its column, 16px type on a phone so iOS does not zoom into it. */
export const FIELD = 'w-full min-w-0 min-h-[44px] rounded-xl border bg-gray-50 px-3 py-2.5 text-base sm:text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-colors';
export const fieldBorder = (error?: string) => (error ? 'border-red-400' : 'border-gray-200');
export const LABEL = 'block text-sm font-medium text-gray-700 mb-1.5';
const BUTTON = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
export const QUIET_BUTTON = cn(BUTTON, 'border border-gray-300 bg-white text-[#1a1a2e] hover:bg-gray-50');
export const PRIMARY_BUTTON = cn(BUTTON, 'bg-rsn-red text-white hover:bg-rsn-red-hover');
export const DANGER_BUTTON = cn(BUTTON, 'border border-red-200 bg-white text-red-600 hover:bg-red-50');
/** The confirm button of a destructive dialog. */
export const SOLID_DANGER_BUTTON = cn(BUTTON, 'bg-red-600 text-white hover:bg-red-500');

/** A card of the organiser's section: a heading, an optional line under it, an optional control at its right. */
export function OrganiserCard({ title, hint, action, children, testId }: {
  title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode; testId: string;
}) {
  return (
    <Card data-testid={testId} className="!p-4 sm:!p-6 min-w-0 animate-fade-in-up">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="text-lg font-semibold text-[#1a1a2e] [overflow-wrap:anywhere]">{title}</h2>
          {hint && <p className="mt-0.5 text-sm text-gray-500 [overflow-wrap:anywhere]">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4 min-w-0">{children}</div>
    </Card>
  );
}

export function LoadingRows({ label, rows = 2 }: { label: string; rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-11 rounded-xl bg-gray-100 animate-pulse" />)}
    </div>
  );
}

export function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span className="min-w-0 flex-1 basis-40">{message}</span>
      <button type="button" onClick={onRetry} className={QUIET_BUTTON}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
      </button>
    </div>
  );
}

export function EmptyRow({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p data-testid={testId} className="rounded-xl border border-dashed border-gray-200 px-3 py-3 text-sm text-gray-500">{children}</p>;
}

/** A sentence under the field it is about. */
export function FieldError({ id, message }: { id?: string; message?: string }) {
  return message ? <p id={id} role="alert" className="mt-1 text-xs text-red-500">{message}</p> : null;
}
