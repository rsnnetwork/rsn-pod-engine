// Screen 2, "Let's get you started". The member is already signed in (they came
// from an approval email or Google), so the two buttons choose how the profile
// is filled in: from their own LinkedIn link, which the server looks up while
// they answer the questions, or by hand ("Continue with email").

import { useState } from 'react';
import { Linkedin, Mail } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import OnboardingShell from './OnboardingShell';
import LinkedinField from './LinkedinField';
import { SIGNUP, linkedinForInput } from './flow';

interface Props {
  /** The link they gave when they asked to join, if any. */
  linkedinUrl: string | null;
  /** Saves the link and moves on; a rejection is shown under the box. */
  onLinkedin: (url: string) => Promise<void>;
  onEmail: () => void;
  emailBusy: boolean;
}

export default function SignupScreen({ linkedinUrl, onLinkedin, onEmail, emailBusy }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <OnboardingShell pose="welcome" title={SIGNUP.title}>
      <div className="mx-auto flex w-full max-w-sm flex-col">
        <Button
          onClick={() => setOpen(true)}
          disabled={emailBusy}
          aria-expanded={open}
          className="min-h-[52px] w-full bg-[#0A66C2] text-base hover:bg-[#004182]"
        >
          <Linkedin className="mr-2 h-5 w-5" aria-hidden />
          {SIGNUP.linkedin}
        </Button>
        <p className="mt-2 text-center text-sm text-gray-600">{SIGNUP.linkedinLine}</p>

        {open && (
          <div className="mt-4">
            <LinkedinField initial={linkedinForInput(linkedinUrl)} submitLabel="Continue" onSubmit={onLinkedin} />
          </div>
        )}

        <Button
          variant="outline"
          onClick={onEmail}
          isLoading={emailBusy}
          className="mt-6 min-h-[52px] w-full bg-white text-base"
        >
          {!emailBusy && <Mail className="mr-2 h-5 w-5" aria-hidden />}
          {SIGNUP.email}
        </Button>
      </div>
    </OnboardingShell>
  );
}
