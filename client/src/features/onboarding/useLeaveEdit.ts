// Edit mode returns to where the member came from: For You's "Edit who I want
// to meet", or Your profile's "Edit answers". The pages that link here pass
// nothing, so the way back is this tab's own history: every entry the flow
// pushed since it opened is counted by its key (Back and Forward move along
// them), and leaving goes back past all of them. A page opened straight onto
// edit mode, with nothing of the app before it, goes to a sensible page instead.
//
// A save can make the tour due (a member who finished before it existed), and it
// opens over the page they come back to. Either way out tells it to leave them
// there (tour-landing.ts): going back through the history carries nothing, so a
// mark for the visit; a page opened instead carries LANDED.

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { LANDED, editFallback, type EditTarget } from './flow';
import { markReturned } from './tour-landing';

export function useLeaveEdit(): (target: EditTarget) => void {
  const location = useLocation();
  const navigate = useNavigate();
  const memberId = useAuthStore(s => s.user?.id as string | undefined);
  const keys = useRef<string[]>([]);
  // The first page of a tab's history has the key "default": nothing of the app is behind it.
  const cameFromApp = useRef(location.key !== 'default');

  useEffect(() => {
    const at = keys.current.indexOf(location.key);
    keys.current = at === -1 ? [...keys.current, location.key] : keys.current.slice(0, at + 1);
  }, [location.key]);

  return (target) => {
    if (cameFromApp.current && keys.current.length) {
      markReturned(memberId);
      navigate(-keys.current.length);
    } else {
      navigate(editFallback(target), { replace: true, state: LANDED });
    }
  };
}
