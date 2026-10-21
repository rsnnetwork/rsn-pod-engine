// Mounts the wizard for someone who has just finished onboarding. Lives in the
// layout rather than the flow, because the deck sends them "straight into
// Suggestions" and the tour plays over it — so what they see behind the cards
// is their own suggestions, not a fifth onboarding screen.
//
// However it ends, finished or skipped, the member lands on For You: the
// client's 19 Oct feedback, "take people straight to a full page of their
// suggested matches". Replaying it from Support is a different mount (it has
// no saved outcome and no destination) and stays on Support.

import { useLocation, useNavigate } from 'react-router-dom';
import HowRsnWorks from './HowRsnWorks';
import { useTourState } from './useTourState';

export default function OnboardingTour() {
  const { pending, failed, markSeen } = useTourState();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Not over the flow itself: they are still answering.
  if (pathname.startsWith('/onboarding')) return null;

  const finish = (outcome: 'completed' | 'skipped') => {
    markSeen(outcome);
    if (pathname !== '/') navigate('/');
  };

  return <HowRsnWorks open={pending} mode="onboarding" failed={failed} onFinish={finish} />;
}
