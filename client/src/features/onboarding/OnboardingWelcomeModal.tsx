import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import SheepAvatar from '@/components/brand/SheepAvatar';

// A first nudge that INVITES (never forces) a member who has not finished
// onboarding into it. It pops once per browser session on the pages that
// mount it, so it re-reminds on each new sign-in but never re-pops as the
// member clicks around; the shell's "Complete your profile" banner is the
// always-on fallback. Start is the prominent action; "Maybe later" is quiet.
//
// 21 Oct 2026: it no longer asks for a LinkedIn link. Screen 2 of the
// onboarding ("Let's get you started") does, with the link they gave when they
// asked to join already in the box.
export default function OnboardingWelcomeModal() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);

  const userId: string | undefined = user?.id;
  const done = user?.onboardingCompleted === true;
  const seenKey = userId ? `rsn_onb_welcome_seen_${userId}` : '';

  useEffect(() => {
    if (!userId || done || !seenKey) return;
    if (sessionStorage.getItem(seenKey)) return;
    setOpen(true);
  }, [userId, done, seenKey]);

  function dismiss() {
    if (seenKey) sessionStorage.setItem(seenKey, '1');
    setOpen(false);
  }

  function start() {
    dismiss();
    navigate('/onboarding');
  }

  if (!userId || done) return null;

  const firstName: string =
    user?.firstName || (user?.displayName ? String(user.displayName).split(/\s+/)[0] : '') || 'there';

  return (
    <Modal open={open} onClose={dismiss} className="max-w-md">
      <div className="flex flex-col items-center gap-6 pt-4 text-center">
        <SheepAvatar pose="wave" size={96} />
        <div>
          <h2 className="font-display text-2xl font-semibold leading-snug text-[#1a1a2e]">
            Welcome to REASON, {firstName}.
          </h2>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-gray-500">
            Four quick questions, and REASON can suggest the people you want to meet. It takes about a minute.
          </p>
        </div>

        <div className="flex w-full flex-col items-center gap-3">
          <Button onClick={start} className="min-h-[54px] w-full justify-center text-base font-semibold">
            Get started <ArrowRight className="ml-2 h-5 w-5" />
          </Button>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-[44px] px-4 text-sm font-medium text-gray-500 transition-colors hover:text-gray-700"
          >
            Maybe later
          </button>
        </div>
      </div>
    </Modal>
  );
}
