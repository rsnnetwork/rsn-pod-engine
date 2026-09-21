// Mounts the wizard for someone who has just finished onboarding. Lives in the
// layout rather than the flow, because the deck sends them "straight into
// Suggestions" and the tour plays over it — so what they see behind the cards
// is their own suggestions, not a fifth onboarding screen.

import { useLocation } from 'react-router-dom';
import HowRsnWorks from './HowRsnWorks';
import { useTourState } from './useTourState';

export default function OnboardingTour() {
  const { pending, markSeen } = useTourState();
  const location = useLocation();

  // Not over the flow itself: they are still answering.
  if (location.pathname.startsWith('/onboarding')) return null;

  return (
    <HowRsnWorks
      open={pending}
      mode="onboarding"
      onFinish={(outcome) => markSeen(outcome)}
    />
  );
}
