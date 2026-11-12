// The consent step before a member leaves for Google or Microsoft (Shirley pilot S8, D7): what REASON reads (busy and
// free times of the main calendar only), what it never reads (titles, people, places, notes), what it is for, how long
// it is kept, that it is optional and how to disconnect, and that it is neither the invitation REASON emails nor the
// calendar file a meeting offers. A bottom sheet on phones, a centred dialog from 768px (Sheet portals to <body>), 44px
// buttons.
//
// Where sign-in cannot work (the iPhone home-screen app, another app's browser: S8 review I2) the sheet says so and
// offers to open REASON in a real browser, on Settings with this sheet open again, instead of a Continue that would fail.

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { CalendarProvider } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import {
  BLOCKED_BROWSER_TEXT, CONSENT_LINES, CONSENT_MICROSOFT_NOTE, CONSENT_TITLE, androidBrowserUrl, appleMobile, blockedBrowser,
  continueLabel, continueUrl, openInBrowserLabel,
} from './calendar-words';
import { calendarErrorMessage, useConnectCalendar } from './useCalendar';

const BUTTON = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] px-4 text-[14px] font-bold disabled:opacity-60';

interface Props {
  provider: CalendarProvider | null;
  /** The app path to come back to after the provider (this page). */
  returnTo: string;
  onClose: () => void;
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export default function CalendarConsentSheet({ provider, returnTo, onClose }: Props) {
  const { addToast } = useToastStore();
  const connect = useConnectCalendar();
  const blocked = useMemo(() => blockedBrowser(navigator.userAgent, isStandalone(), navigator.maxTouchPoints), []);
  // On an iPhone or iPad, "Open in Safari" from the home-screen app or another app's browser often opens the same kind of
  // view again, so Copy link (which always works) leads and Open in Safari is the second choice (S8 review N2).
  const copyFirst = useMemo(() => appleMobile(navigator.userAgent, navigator.maxTouchPoints), []);
  const [copied, setCopied] = useState(false);
  // Back from the provider's page can bring this page back from the browser's memory (bfcache) as it was left: busy,
  // with both buttons off. Start again then (S8 review M2).
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) connect.reset(); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset is stable for the life of the mutation
  }, []);
  // The page is about to be left for the provider: the button stays busy until it is.
  const leaving = connect.isPending || connect.isSuccess;
  const go = () => {
    if (!provider || leaving) return;
    connect.mutate({ provider, returnTo }, {
      onError: (err) => addToast(calendarErrorMessage(err, 'We could not start connecting your calendar. Please try again.'), 'error'),
    });
  };

  const android = /Android/.test(navigator.userAgent);
  const carryOn = provider ? continueUrl(window.location.origin, provider) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(carryOn);
      setCopied(true);
    } catch {
      addToast(`Copy this link into your browser: ${carryOn}`, 'info', { duration: 10000 });
    }
  };

  const PRIMARY = 'bg-reason-ink text-white hover:opacity-90';
  const SECONDARY = 'border border-reason-line bg-white text-reason-ink';
  const copyButton = blocked && (
    <button type="button" onClick={() => void copy()} data-testid="calendar-copy-link" className={cn(BUTTON, copyFirst ? PRIMARY : SECONDARY)}>
      {copied ? 'Link copied' : 'Copy link'}
    </button>
  );
  const openLink = blocked && (
    <a
      href={android && blocked === 'in-app' ? androidBrowserUrl(carryOn) : carryOn}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="calendar-open-in-browser"
      className={cn(BUTTON, copyFirst ? SECONDARY : PRIMARY)}
    >
      {openInBrowserLabel(blocked, android)}
    </a>
  );
  // The leading action sits last (on the right, where Continue is), the other before it.
  const footer = !provider ? null : blocked ? (
    copyFirst ? <>{openLink}{copyButton}</> : <>{copyButton}{openLink}</>
  ) : (
    <>
      <button type="button" onClick={onClose} disabled={leaving} className={cn(BUTTON, 'border border-reason-line bg-white text-reason-ink')}>
        Not now
      </button>
      <button
        type="button"
        onClick={go}
        disabled={leaving}
        aria-busy={leaving}
        data-testid="calendar-consent-continue"
        className={cn(BUTTON, 'bg-reason-ink text-white enabled:hover:opacity-90')}
      >
        {leaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
        {continueLabel(provider)}
      </button>
    </>
  );

  return (
    <Sheet open={provider !== null} onClose={() => { if (!leaving) onClose(); }} title={CONSENT_TITLE} footer={footer}>
      {blocked && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900" role="note" data-testid="calendar-blocked-browser">
          {BLOCKED_BROWSER_TEXT[blocked]}
        </p>
      )}
      <ul className="space-y-2.5 text-[14px] leading-snug text-reason-ink" data-testid="calendar-consent-text">
        {CONSENT_LINES.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-reason-red" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {provider === 'microsoft' && <p className="mt-3 text-[12px] text-gray-500">{CONSENT_MICROSOFT_NOTE}</p>}
    </Sheet>
  );
}
