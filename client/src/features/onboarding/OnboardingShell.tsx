// ─── Onboarding shell ────────────────────────────────────────────────────────
//
// The frame every screen sits in: sheep, title, body, and a footer that is
// always in reach. A fixed-height column that owns its own scrolling (the
// layout two rounds of clipping bugs arrived at, 10 Sep), so the footer is
// never laid over an option, and a body taller than the phone scrolls from its
// top instead of being cut off there: my-auto inside a flex column centres a
// short screen and leaves a tall one where it starts.
//
// Each screen is a new shell (the flow keys it by step), so the next question
// opens at its top and its heading takes the focus, which is where a screen
// reader and the keyboard pick it up.

import { useEffect, useRef, type ReactNode } from 'react';
import SheepAvatar, { type SheepPose } from '@/components/brand/SheepAvatar';

interface Props {
  pose: SheepPose;
  /** The sheep's box. Smaller on the long screens, so the first options are in view. */
  sheepSize?: number;
  /** "1 of 4" and the bar: the four questions only. */
  progress?: { current: number; total: number };
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Always in reach at the bottom, whatever the body does. Screen 2 has none: its choices are the body. */
  footer?: ReactNode;
}

const SIDES = 'pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]';

export default function OnboardingShell({ pose, sheepSize = 112, progress, title, subtitle, children, footer }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-gradient-to-b from-white to-gray-50 text-[#1a1a2e]">
      {progress && (
        <div
          className={`shrink-0 pt-[max(env(safe-area-inset-top),0.75rem)] ${SIDES}`}
          role="progressbar"
          aria-valuenow={progress.current}
          aria-valuemin={1}
          aria-valuemax={progress.total}
          aria-label={`Question ${progress.current} of ${progress.total}`}
        >
          <div className="mx-auto flex w-full max-w-xl items-center gap-3 py-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-rsn-red transition-[width] duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
            <span className="shrink-0 text-xs font-medium text-gray-500">{progress.current} of {progress.total}</span>
          </div>
        </div>
      )}

      <div
        data-testid="onboarding-body"
        className={`flex flex-1 flex-col overflow-y-auto overscroll-contain py-6 ${SIDES} ${
          progress ? '' : 'pt-[max(env(safe-area-inset-top),1.5rem)]'
        } ${footer ? '' : 'pb-[max(env(safe-area-inset-bottom),1.5rem)]'}`}
      >
        <div className="mx-auto my-auto flex w-full max-w-xl flex-col items-center">
          <SheepAvatar pose={pose} size={sheepSize} className="mb-3" />
          {title && (
            <h1
              ref={heading}
              tabIndex={-1}
              // Focused for the screen reader, not pressed: the global focus ring would box it on every screen.
              className="text-balance text-center font-display text-2xl font-bold leading-tight outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            >
              {title}
            </h1>
          )}
          {subtitle && <p className="mt-2 text-center text-sm text-gray-600">{subtitle}</p>}
          <div className="mt-6 w-full">{children}</div>
        </div>
      </div>

      {footer && (
        <div className={`shrink-0 border-t border-gray-200 bg-white/95 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] backdrop-blur ${SIDES}`}>
          <div className="mx-auto flex w-full max-w-xl items-center justify-end gap-2">{footer}</div>
        </div>
      )}
    </div>
  );
}
