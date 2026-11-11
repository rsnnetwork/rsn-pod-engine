// Back from Google or Microsoft (Shirley pilot S8, D7). The provider sends the browser to the API, which sends it on to
// the page the member started from with ?calendar=<outcome>&calendarProvider=<p>[&calendarTicket=...]. Mounted once in
// the signed-in shell, so it works on Settings and in Messages alike. A ticket is finished by the member who is signed
// in here (the server refuses it for anyone else), once; the outcome is said in a toast; the calendar words leave the
// address by replacing it, so Back or a refresh never says it twice. Draws nothing.

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToastStore } from '@/stores/toastStore';
import { OUTCOME_MESSAGE, connectedMessage, isOutcome, isProviderName } from './calendar-words';
import { calendarErrorMessage, useFinishCalendar } from './useCalendar';

const CALENDAR_PARAMS = ['calendar', 'calendarProvider', 'calendarTicket'] as const;

export default function CalendarReturnWatcher() {
  const [params, setParams] = useSearchParams();
  const { addToast } = useToastStore();
  const finish = useFinishCalendar();
  const handled = useRef<string | null>(null);

  const outcome = params.get('calendar');
  const provider = params.get('calendarProvider');
  const ticket = params.get('calendarTicket');

  useEffect(() => {
    if (!isOutcome(outcome)) return;
    // Out of the address every time they are seen: a page that rewrites its own query from an older copy (Messages
    // drops its ?schedule=1 that way) may put them back once, and a refresh must never finish a spent ticket again.
    setParams((now) => {
      const next = new URLSearchParams(now);
      for (const k of CALENDAR_PARAMS) next.delete(k);
      return next;
    }, { replace: true });
    const seen = `${outcome}|${provider}|${ticket}`;
    if (handled.current === seen) return;
    handled.current = seen;

    if (outcome !== 'finish') {
      const { text, tone } = OUTCOME_MESSAGE[outcome];
      addToast(text, tone);
      return;
    }
    if (!isProviderName(provider) || !ticket) {
      addToast(OUTCOME_MESSAGE.failed.text, 'error');
      return;
    }
    finish.mutate({ provider, ticket }, {
      onSuccess: () => addToast(connectedMessage(provider), 'success', { duration: 4000 }),
      onError: (err) => addToast(calendarErrorMessage(err, OUTCOME_MESSAGE.failed.text), 'error'),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per outcome that arrives in the address
  }, [outcome, provider, ticket]);

  return null;
}
