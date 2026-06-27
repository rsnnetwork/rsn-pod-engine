import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Linkedin } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';
import HostPresence from './HostPresence';

// Beautiful first-nudge popup that INVITES (never forces) a new member into the
// host chat. It pops once per SESSION on the dashboard / profile until onboarding
// is done, so it re-reminds on each new login but never re-pops as the member
// clicks around. The persistent AppLayout banner is the always-on fallback.
// Start is the prominent action; "Maybe later" is a quiet, smaller link.
//
// For members who don't have a LinkedIn on file yet (invite signups — join-request
// signups always do), the modal also offers an optional LinkedIn field. Adding it
// here lets the profile lookup run the fast, high-confidence LinkedIn path the
// moment they enter onboarding. It's fully skippable — leaving it blank falls back
// to the basic name + email + country search.
export default function OnboardingWelcomeModal() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [needsLinkedin, setNeedsLinkedin] = useState(false);
  const [linkedin, setLinkedin] = useState('');
  const [starting, setStarting] = useState(false);

  const userId = user?.id;
  const done = (user as any)?.onboardingCompleted === true;
  const seenKey = userId ? `rsn_onb_welcome_seen_${userId}` : '';

  useEffect(() => {
    if (!userId || done || !seenKey) return;
    // Per-session: re-reminds each new login until onboarding is complete.
    if (sessionStorage.getItem(seenKey)) return;
    setOpen(true);
    // Do we already have a LinkedIn? If not, offer the optional field.
    api
      .get('/onboarding/known')
      .then((res) => {
        if (!res.data?.data?.linkedin) setNeedsLinkedin(true);
      })
      .catch(() => {});
  }, [userId, done, seenKey]);

  function dismiss() {
    if (seenKey) sessionStorage.setItem(seenKey, '1');
    setOpen(false);
  }

  async function start() {
    if (starting) return;
    setStarting(true);
    // Persist the LinkedIn (if they added one) BEFORE onboarding, so the lookup runs
    // the fast LinkedIn path the instant they land. Best-effort — never block "start".
    const url = linkedin.trim();
    if (needsLinkedin && url) {
      await api.post('/onboarding/enrich/apply', { linkedin: url }).catch(() => {});
    }
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

        {needsLinkedin && (
          <div className="w-full text-left">
            <label htmlFor="onb-linkedin" className="text-sm font-medium text-[#1a1a2e]">
              Add your LinkedIn{' '}
              <span className="font-normal text-gray-400">(optional — we'll build your profile faster)</span>
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 focus-within:border-rsn-red/50 focus-within:ring-2 focus-within:ring-rsn-red/20">
              <Linkedin className="h-4 w-4 shrink-0 text-gray-400" />
              <input
                id="onb-linkedin"
                type="url"
                value={linkedin}
                onChange={(e) => setLinkedin(e.target.value)}
                placeholder="linkedin.com/in/your-name"
                className="min-h-[44px] w-full bg-transparent text-[15px] text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none"
              />
            </div>
          </div>
        )}

        <div className="flex w-full flex-col items-center gap-3">
          <Button
            onClick={start}
            isLoading={starting}
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
