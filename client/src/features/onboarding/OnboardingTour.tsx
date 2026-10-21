// Mounts the wizard for someone who has just finished onboarding. Lives in the
// layout rather than the flow, because the deck sends them "straight into
// Suggestions" and the tour plays over it — so what they see behind the cards
// is their own suggestions, not a fifth onboarding screen.
//
// However it ends, finished or skipped, the member lands on For You (the
// client's 19 Oct feedback, "take people straight to a full page of their
// suggested matches"), unless the flow itself put them where they are: the page
// they followed a link to before they finished, or the one they came from to
// change an answer (final review, 21 Oct). Replaying it from Support is a
// different mount (it has no saved outcome and no destination) and stays on
// Support.

import { useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import HowRsnWorks from './HowRsnWorks';
import { useTourState } from './useTourState';
import { isLanded } from './flow';
import { takeReturned } from './tour-landing';

export default function OnboardingTour() {
  const { pending, failed, markSeen } = useTourState();
  const { pathname, state } = useLocation();
  const navigate = useNavigate();
  const memberId = useAuthStore(s => s.user?.id as string | undefined);
  // Decided at the first press and kept: a press after a save that did not go through decides the same way.
  const stays = useRef(false);

  // Not over the flow itself: they are still answering.
  if (pathname.startsWith('/onboarding')) return null;

  const finish = (outcome: 'completed' | 'skipped') => {
    markSeen(outcome);
    stays.current = stays.current || isLanded(state) || takeReturned(memberId);
    if (!stays.current && pathname !== '/') navigate('/');
  };

  return <HowRsnWorks open={pending} mode="onboarding" failed={failed} onFinish={finish} />;
}
