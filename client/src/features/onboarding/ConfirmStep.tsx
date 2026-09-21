// ─── Confirm ─────────────────────────────────────────────────────────────────
//
// "Here's your profile - built from your answers." Every row is something the
// member ticked or typed. The old screen showed a country guessed from their IP
// address, a company guessed from their email domain and an About line cut out
// of a LinkedIn page, all presented as fact — and in Stefan's test the guess was
// simply wrong. Nothing on this screen was guessed.
//
// Editing a row jumps back to that question and returns here, rather than
// unfolding six tiles inside a row: on a phone the inline version pushes
// everything else off the screen.

import { useState } from 'react';
import {
  ONBOARDING_INTENTS, ONBOARDING_MEET, ONBOARDING_OFFERS, ONBOARDING_INDUSTRIES,
  ONBOARDING_SELF_KINDS, ONBOARDING_LIMITS, shortLabelFor,
  type OnboardingState, type OnboardingStep,
} from '@rsn/shared';
import { Button } from '@/components/ui/Button';
import OnboardingShell from './OnboardingShell';

type Answers = Partial<OnboardingState['answers']>;

interface Props {
  answers: Answers;
  onChange: (next: Answers) => void;
  onEditStep: (step: OnboardingStep) => void;
  onBack: () => void;
  onConfirm: () => void;
  submitting: boolean;
}

export default function ConfirmStep({ answers, onChange, onEditStep, onBack, onConfirm, submitting }: Props) {
  const [showOptional, setShowOptional] = useState(
    !!(answers.jobTitle || answers.company || answers.about),
  );

  const list = (keys: string[] | undefined, options: readonly { key: string; label: string; shortLabel: string }[]) =>
    (keys ?? []).map(k => shortLabelFor(options, k)).join(' · ');

  const rows: Array<{ label: string; value: string; step: OnboardingStep }> = [
    { label: "You're here to", value: answers.intent ? shortLabelFor(ONBOARDING_INTENTS, answers.intent) : '', step: 'q1' },
    { label: 'You want to meet', value: list(answers.lookingToMeet, ONBOARDING_MEET), step: 'q2' },
    { label: 'You can offer', value: list(answers.canOffer, ONBOARDING_OFFERS), step: 'q3' },
    {
      label: 'Industries',
      value: [
        answers.industryOther?.trim(),
        list((answers.industries ?? []).filter(k => k !== 'other'), ONBOARDING_INDUSTRIES),
      ].filter(Boolean).join(' · '),
      step: 'q4',
    },
    { label: 'You are', value: list(answers.selfKinds, ONBOARDING_SELF_KINDS), step: 'q5' },
  ];

  return (
    <OnboardingShell
      pose="thinking"
      title="Here's your profile"
      subtitle="Built from your answers. Change anything that is not right."
      onBack={onBack}
      progress={{ current: 5, total: 5 }}
      footer={
        <Button onClick={onConfirm} disabled={submitting} className="min-h-[48px] w-full sm:w-auto">
          {submitting ? 'Saving…' : 'Looks right - continue'}
        </Button>
      }
    >
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={`flex items-start gap-3 px-4 py-3 ${i > 0 ? 'border-t border-gray-100' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{r.label}</p>
              {/* min-w-0 and break-words: the old screen let a long value paint
                  straight out of its box (the LinkedIn URL on slide 9). */}
              <p className="mt-0.5 min-w-0 break-words text-sm text-[#1a1a2e]">
                {r.value || <span className="text-gray-400">Not set</span>}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onEditStep(r.step)}
              className="min-h-[44px] shrink-0 rounded-lg px-3 text-sm font-medium text-rsn-red hover:bg-rsn-red-light"
            >
              Edit
            </button>
          </div>
        ))}
      </div>

      {/* Optional, and clearly so: a blank one costs the member nothing, and
          the deck's rule means we will not fill it in for them. */}
      {!showOptional ? (
        <button
          type="button"
          onClick={() => setShowOptional(true)}
          className="mt-4 min-h-[44px] w-full rounded-xl border border-dashed border-gray-300 px-4 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          Add your role, company or a line about you
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <Field
            id="job-title" label="Your role" placeholder="Founder, Head of Sales, Developer…"
            value={answers.jobTitle ?? ''} maxLength={ONBOARDING_LIMITS.roleMaxLen}
            onChange={v => onChange({ ...answers, jobTitle: v })}
          />
          <Field
            id="company" label="Company" placeholder="Where you work"
            value={answers.company ?? ''} maxLength={ONBOARDING_LIMITS.companyMaxLen}
            onChange={v => onChange({ ...answers, company: v })}
          />
          <Field
            id="about" label="About you" placeholder="One line, in your own words"
            value={answers.about ?? ''} maxLength={ONBOARDING_LIMITS.aboutMaxLen}
            hint="Shown on your public profile."
            onChange={v => onChange({ ...answers, about: v })}
          />
        </div>
      )}
    </OnboardingShell>
  );
}

function Field({ id, label, placeholder, value, maxLength, hint, onChange }: {
  id: string; label: string; placeholder: string; value: string; maxLength: number;
  hint?: string; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-[#1a1a2e]">{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={e => onChange(e.target.value)}
        className="h-12 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-rsn-red"
      />
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
