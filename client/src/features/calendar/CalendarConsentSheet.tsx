// The consent step before a member leaves for Google or Microsoft (Shirley pilot S8, D7): what REASON reads (busy and
// free times of the main calendar only), what it never reads (titles, people, places, notes), what it is for, that it
// is optional and how to disconnect, and that it is not the invitation REASON emails. A bottom sheet on phones, a
// centred dialog from 768px (Sheet portals to <body>), 44px buttons.

import { Loader2 } from 'lucide-react';
import type { CalendarProvider } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { CONSENT_LINES, CONSENT_TITLE, continueLabel } from './calendar-words';
import { calendarErrorMessage, useConnectCalendar } from './useCalendar';

const BUTTON = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] px-4 text-[14px] font-bold disabled:opacity-60';

interface Props {
  provider: CalendarProvider | null;
  /** The app path to come back to after the provider (this page). */
  returnTo: string;
  onClose: () => void;
}

export default function CalendarConsentSheet({ provider, returnTo, onClose }: Props) {
  const { addToast } = useToastStore();
  const connect = useConnectCalendar();
  // The page is about to be left for the provider: the button stays busy until it is.
  const leaving = connect.isPending || connect.isSuccess;
  const go = () => {
    if (!provider || leaving) return;
    connect.mutate({ provider, returnTo }, {
      onError: (err) => addToast(calendarErrorMessage(err, 'We could not start connecting your calendar. Please try again.'), 'error'),
    });
  };

  return (
    <Sheet
      open={provider !== null}
      onClose={() => { if (!leaving) onClose(); }}
      title={CONSENT_TITLE}
      footer={provider && (
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
      )}
    >
      <ul className="space-y-2.5 text-[14px] leading-snug text-reason-ink" data-testid="calendar-consent-text">
        {CONSENT_LINES.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-reason-red" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
