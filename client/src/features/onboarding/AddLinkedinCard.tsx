// Screen 7, for email sign-ups: "Add your LinkedIn profile so people can learn
// more about you. You can do this later." [Add LinkedIn] opens the same link
// box as screen 2, with the link from their join form in it when there is one.
// Adding it turns LinkedIn on: the lookup fills in whatever they have not typed.

import { useState } from 'react';
import { Linkedin } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import LinkedinField from './LinkedinField';
import { PROFILE } from './flow';

interface Props {
  /** The link they gave when they asked to join, as they would type it; empty when there is none. */
  initial: string;
  onAdd: (url: string) => Promise<void>;
  onLater: () => void;
}

export default function AddLinkedinCard({ initial, onAdd, onLater }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4" aria-label="Add your LinkedIn profile">
      <div className="flex items-start gap-3">
        <Linkedin className="mt-0.5 h-5 w-5 shrink-0 text-[#0A66C2]" aria-hidden />
        <p className="text-sm text-gray-700">{PROFILE.addLinkedinLine}</p>
      </div>
      {open ? (
        <div className="mt-3">
          <LinkedinField initial={initial} submitLabel="Add" onSubmit={onAdd} />
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button onClick={() => setOpen(true)} className="min-h-[44px] w-full bg-[#0A66C2] hover:bg-[#004182]">
            {PROFILE.addLinkedin}
          </Button>
          <Button variant="outline" onClick={onLater} className="min-h-[44px] w-full bg-white">
            {PROFILE.later}
          </Button>
        </div>
      )}
    </section>
  );
}
