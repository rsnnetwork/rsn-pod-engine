// The call page's frame (Part 2, Task 12): the REASON mark, the four progress dots ("Open link · Identify · Check · Join
// call") and the page's two parts. On a phone and a tablet it is one column: the step, with the event above it. From
// 1024px the event stays on the left and the step sits in a card on the right. Clear of the notch and the home bar on
// every side; nothing is wider than the screen.
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import ReasonMark from '@/features/reason/brand/ReasonMark';
import { PROGRESS_STEPS } from './call-entry';

export function CallProgress({ at }: { at: number }) {
  return (
    <ol aria-label="Progress" className="grid grid-cols-4 gap-1.5" data-testid="call-progress">
      {PROGRESS_STEPS.map((label, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <li key={label} aria-current={current ? 'step' : undefined} className="flex min-w-0 flex-col items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                'h-1.5 w-full rounded-full transition-colors',
                done || current ? 'bg-reason-red' : 'bg-reason-line',
              )}
            />
            <span className={cn('truncate text-[11px] leading-none min-[400px]:text-[12px]', current ? 'font-bold text-reason-ink' : 'text-reason-muted')}>
              {label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

interface FrameProps {
  /** Which progress dot is current (0-3); none on a screen outside the four steps. */
  progress: number | null;
  /** The event, kept beside the step from 1024px. */
  aside?: ReactNode;
  children: ReactNode;
}

export default function CallFrame({ progress, aside, children }: FrameProps) {
  return (
    <div
      className="min-h-[100dvh] bg-reason-warm font-reason text-reason-ink antialiased"
      style={{
        paddingTop: 'max(12px, env(safe-area-inset-top))',
        paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(16px, env(safe-area-inset-left))',
        paddingRight: 'max(16px, env(safe-area-inset-right))',
      }}
    >
      <div className={cn('mx-auto w-full', aside ? 'max-w-[520px] lg:max-w-[1040px]' : 'max-w-[520px]')}>
        <header className="flex min-h-[44px] items-center justify-between gap-3 py-2 sm:py-4">
          <ReasonMark variant="mobile" />
        </header>
        <div className={cn(aside && 'lg:grid lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start lg:gap-10')}>
          {aside && <aside className="hidden lg:sticky lg:top-6 lg:block">{aside}</aside>}
          <main className="min-w-0">
            <div className="sm:rounded-3xl sm:border sm:border-reason-line sm:bg-white sm:p-8 sm:shadow-[0_18px_50px_-30px_rgba(17,19,26,.35)]">
              {progress !== null && (
                <div className="mb-6">
                  <CallProgress at={progress} />
                </div>
              )}
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
