// ─── Onboarding shell ────────────────────────────────────────────────────────
//
// The frame every step sits in: sheep, title, body, and a footer that is always
// reachable. The layout is the one the chat flow arrived at after two rounds of
// clipping bugs (10 Sep) — a fixed-height column that owns its own scrolling,
// with the content centred by margin rather than by justify-center, because a
// card taller than the frame gets clipped at the TOP by centring and then
// cannot be scrolled back to.

import type { ReactNode } from 'react';
import SheepAvatar, { type SheepPose } from '@/components/brand/SheepAvatar';

interface Props {
  pose: SheepPose;
  /** "1 of 5" and the bar. Absent on the welcome screen. */
  progress?: { current: number; total: number };
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Always in reach at the bottom, whatever the body does. */
  footer: ReactNode;
  onBack?: () => void;
}

export default function OnboardingShell({ pose, progress, title, subtitle, children, footer, onBack }: Props) {
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-gradient-to-b from-white to-gray-50">
      {progress && (
        <div
          className="shrink-0 px-4 pt-[max(env(safe-area-inset-top),0.75rem)]"
          role="progressbar"
          aria-valuenow={progress.current}
          aria-valuemin={1}
          aria-valuemax={progress.total}
          aria-label={`Step ${progress.current} of ${progress.total}`}
        >
          <div className="mx-auto flex w-full max-w-xl items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="-ml-2 flex h-11 min-w-[44px] items-center justify-center rounded-lg px-2 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800"
              >
                Back
              </button>
            ) : (
              // Keeps the bar in the same place on the first step, so nothing
              // shifts sideways as you move through.
              <span className="-ml-2 h-11 min-w-[44px]" aria-hidden />
            )}
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-rsn-red transition-[width] duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs font-medium text-gray-400">
              {progress.current} of {progress.total}
            </span>
          </div>
        </div>
      )}

      {/* The one scroller. my-auto centres a short body without clipping a tall
          one — justify-center would cut the top off and put it out of reach. */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-6">
        <div className="mx-auto my-auto flex w-full max-w-xl flex-col items-center">
          <SheepAvatar pose={pose} size={112} className="mb-4" />
          {title && <h1 className="text-center font-display text-2xl font-bold text-[#1a1a2e]">{title}</h1>}
          {subtitle && <p className="mt-2 text-center text-sm text-gray-500">{subtitle}</p>}
          <div className="mt-6 w-full">{children}</div>
        </div>
      </div>

      <div className="shrink-0 border-t border-gray-200 bg-white/90 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-xl justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}
