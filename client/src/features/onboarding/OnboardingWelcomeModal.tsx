import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import HostPresence from './HostPresence';

// Beautiful first-nudge popup that INVITES (never forces) a new member into the
// host chat. It pops once per SESSION on the dashboard / profile until onboarding
// is done, so it re-reminds on each new login but never re-pops as the member
// clicks around. The persistent AppLayout banner is the always-on fallback.
// Start is the prominent action; "Maybe later" is a quiet, smaller link.
export default function OnboardingWelcomeModal() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);

  const userId = user?.id;
  const done = (user as any)?.onboardingCompleted === true;
  const seenKey = userId ? `rsn_onb_welcome_seen_${userId}` : '';

  useEffect(() => {
    if (!userId || done || !seenKey) return;
    // Per-session: re-reminds each new login until onboarding is complete.
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

  const firstName =
    user?.firstName || (user?.displayName ? user.displayName.split(/\s+/)[0] : '') || 'there';

  return (
    <Modal open={open} onClose={dismiss} className="max-w-md">
      <div className="flex flex-col items-center gap-6 pt-4 text-center">
        <HostPresence size={96} state="idle" />
        <div>
          <h2 className="font-display text-2xl font-semibold leading-snug text-[#1a1a2e]">
            Welcome to Reason, {firstName}.
          </h2>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-gray-500">
            One short chat sets up your matching profile so we can connect you with the right people.
            It takes about two minutes.
          </p>
        </div>
        <div className="flex w-full flex-col items-center gap-3">
          <Button
            onClick={start}
            className="min-h-[54px] w-full justify-center text-base font-semibold"
          >
            Start the chat <ArrowRight className="ml-2 h-5 w-5" />
          </Button>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-[40px] px-4 text-sm font-medium text-gray-400 transition-colors hover:text-gray-600"
          >
            Maybe later
          </button>
        </div>
      </div>
    </Modal>
  );
}
