// Which screen the address shows, and the moves between screens.
//
// The step lives in the URL (?step=), so a refresh, the browser's own Back and a
// second device all come back to the same place; it is never past the first
// question still unanswered. ?edit= (a member who has finished) names the one
// part being changed, and ?from=profile marks a question opened from screen 7's
// [Edit], which goes back there.

import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { OnboardingV2Answers, OnboardingV2State, OnboardingV2Step } from '@rsn/shared';
import { parseEdit, questionFor, safeRedirect, stepToShow, type EditTarget, type QuestionStepKey } from './flow';

/** Carried in the history entry of every step the flow's own buttons open (it survives a refresh). */
const OPENED = { openedByFlow: true } as const;

export function useFlowSteps(state: OnboardingV2State, answers: OnboardingV2Answers) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const openedByFlow = (location.state as { openedByFlow?: boolean } | null)?.openedByFlow === true;
  // Decided when the page opened: finishing the flow must not turn it into edit mode on the way out.
  const finished = useRef(state.status === 'completed');
  // The answer screen 7 was left from for [Edit]: on the way back it lands there, not at the top of the page.
  const [returnedFrom, setReturnedFrom] = useState<QuestionStepKey | null>(null);

  const edit: EditTarget | null = finished.current ? (parseEdit(params.get('edit')) ?? 'profile') : null;
  const backToProfile = params.get('from') === 'profile';
  const requested = params.get('step');
  const screen: OnboardingV2Step = edit
    ? (questionFor(requested)?.step ?? (requested === 'profile' ? 'profile' : edit))
    : stepToShow(requested, state.step, answers, openedByFlow);

  // The first page names its step, so the browser's Back from screen 2 returns to Welcome rather than to
  // wherever the draft has got to by then.
  useEffect(() => {
    if (edit || requested) return;
    const named = new URLSearchParams(params);
    named.set('step', screen);
    setParams(named, { replace: true, state: OPENED });
  }, [edit, requested, screen, params, setParams]);

  const go = (step: OnboardingV2Step, from?: 'profile') => {
    const next = new URLSearchParams(params);
    next.set('step', step);
    if (from) next.set('from', from); else next.delete('from');
    setReturnedFrom(null);
    setParams(next, { state: OPENED }); // a push, so the browser's own Back walks back through the flow
  };

  const backToProfileFrom = (step: QuestionStepKey) => {
    go('profile');
    setReturnedFrom(step);
  };

  // The gate sends a member who followed a link before finishing here with ?redirect=<that page>.
  const redirect = safeRedirect(params.get('redirect'));

  return { edit, backToProfile, screen, returnedFrom, redirect, go, backToProfileFrom };
}

/** One press at a time: a double tap lands before React re-renders the button as disabled. */
export function useOnePress() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const once = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, once };
}
