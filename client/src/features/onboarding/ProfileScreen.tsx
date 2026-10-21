// ─── Screen 7: "Here's how others will see you" ────────────────────────────
//
// Photo, name, role and company, industry and time zone, then "Your answers".
// What LinkedIn suggested is filled in and marked, and is only saved when they
// press the last button; nothing it says is written over what the profile
// already holds. While the lookup is still running a calm line says so, and
// its result fills in whatever they have not typed by then.

import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import type { OnboardingV2Answers, OnboardingV2State } from '@rsn/shared';
import { Linkedin } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import OnboardingShell from './OnboardingShell';
import PhotoField from './PhotoField';
import TimeZoneField from './TimeZoneField';
import YourAnswers from './YourAnswers';
import AddLinkedinCard from './AddLinkedinCard';
import LinkedinField from './LinkedinField';
import {
  PROFILE, PROFILE_MAX, linkedinForInput, linkedinNote,
  type ProfileFields, type QuestionStepKey,
} from './flow';

interface ShownField { value: string; fromLinkedin: boolean }

interface Props {
  state: OnboardingV2State;
  answers: OnboardingV2Answers;
  fields: Record<keyof ProfileFields, ShownField>;
  onField: (field: keyof ProfileFields, value: string) => void;
  /** What to say under a field (the time zone included), if anything. */
  fieldError: (field: keyof ProfileFields | 'timezone') => string | null;
  /** A refusal or a failure about the screen as a whole. */
  formError: string | null;
  nameRef: Ref<HTMLInputElement>;
  zone: string | null;
  onZone: (zone: string) => void;
  keptLinkedinPhoto: string | null;
  onKeepLinkedinPhoto: (url: string | null) => void;
  onEditAnswer: (step: QuestionStepKey) => void;
  /** The answer they have just come back from editing: it is scrolled into view, not the top of the page. */
  returnedFrom: QuestionStepKey | null;
  onLinkedin: (url: string) => Promise<void>;
  /** "Later" on the LinkedIn card. */
  linkedinLater: boolean;
  onLinkedinLater: () => void;
  footer: ReactNode;
}

const INPUT = 'h-12 w-full rounded-xl border bg-white px-3 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red sm:text-sm';

function Field({ label, field, shown, onField, max, placeholder, error, inputRef }: {
  label: string; field: keyof ProfileFields; shown: ShownField; onField: Props['onField']; max: number;
  placeholder: string; error?: string | null; inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
      <input
        id={id}
        ref={inputRef}
        type="text"
        value={shown.value}
        maxLength={max}
        placeholder={placeholder}
        autoComplete={field === 'displayName' ? 'name' : field === 'jobTitle' ? 'organization-title' : field === 'company' ? 'organization' : 'off'}
        onChange={e => onField(field, e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : shown.fromLinkedin ? `${id}-from` : undefined}
        className={`${INPUT} ${error ? 'border-rsn-red' : 'border-gray-300'}`}
      />
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-rsn-red" role="alert">{error}</p>}
      {!error && shown.fromLinkedin && (
        <p id={`${id}-from`} className="mt-1 flex items-center gap-1 text-xs text-gray-500">
          <Linkedin className="h-3 w-3" aria-hidden /> From your LinkedIn
        </p>
      )}
    </div>
  );
}

export default function ProfileScreen(props: Props) {
  const {
    state, answers, fields, onField, fieldError, formError, nameRef, zone, onZone, keptLinkedinPhoto, onKeepLinkedinPhoto,
    onEditAnswer, returnedFrom, onLinkedin, linkedinLater, onLinkedinLater, footer,
  } = props;
  const [changingLink, setChangingLink] = useState(false);
  const formErrorLine = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (returnedFrom) document.querySelector(`[data-testid="answer-${returnedFrom}"]`)?.scrollIntoView({ block: 'center' });
  }, [returnedFrom]);
  useEffect(() => {
    if (formError) formErrorLine.current?.scrollIntoView({ block: 'center' });
  }, [formError]);
  const hasLinkedin = !!state.profile.linkedinUrl;
  const status = state.linkedin.status;
  const note = hasLinkedin ? linkedinNote(status) : null;
  const canRetry = hasLinkedin && (status === 'not_found' || status === 'failed');

  return (
    <OnboardingShell pose="thinking" sheepSize={72} title={PROFILE.title} subtitle={PROFILE.subtitle} footer={footer}>
      <div className="space-y-6">
        {formError && (
          <p ref={formErrorLine} className="rounded-xl bg-rsn-red-light px-4 py-3 text-sm font-medium text-rsn-red" role="alert">{formError}</p>
        )}
        <div aria-live="polite">
          {note && (
            <div className="rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-700" data-testid="linkedin-note">
              <div className="flex items-start gap-2">
                {status === 'searching' && <Spinner className="mt-0.5 h-4 w-4 shrink-0" />}
                <p className="min-w-0 flex-1">{note}</p>
              </div>
              {canRetry && !changingLink && (
                <button
                  type="button"
                  onClick={() => setChangingLink(true)}
                  className="mt-1 min-h-[44px] rounded-lg font-semibold text-rsn-red hover:underline"
                >
                  Check your LinkedIn link
                </button>
              )}
              {canRetry && changingLink && (
                <div className="mt-3">
                  <LinkedinField
                    initial={linkedinForInput(state.profile.linkedinUrl)}
                    submitLabel="Use this link"
                    onSubmit={async (url) => { await onLinkedin(url); setChangingLink(false); }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <section aria-label="Your profile" className="space-y-5 rounded-xl border border-gray-200 bg-white p-4">
          <PhotoField
            name={fields.displayName.value}
            avatarUrl={state.profile.avatarUrl}
            linkedinPhotoUrl={state.linkedin.prefill?.photoUrl ?? null}
            keptLinkedinPhoto={keptLinkedinPhoto}
            onKeepLinkedinPhoto={onKeepLinkedinPhoto}
          />
          <Field
            label="Name" field="displayName" shown={fields.displayName} onField={onField}
            max={PROFILE_MAX.displayName} placeholder="Your name" error={fieldError('displayName')} inputRef={nameRef}
          />
          <fieldset className="min-w-0">
            <legend className="mb-2 text-sm font-semibold">Role and company</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Role" field="jobTitle" shown={fields.jobTitle} onField={onField} max={PROFILE_MAX.jobTitle}
                placeholder="Founder, designer, investor…" error={fieldError('jobTitle')}
              />
              <Field
                label="Company" field="company" shown={fields.company} onField={onField} max={PROFILE_MAX.company}
                placeholder="Where you work" error={fieldError('company')}
              />
            </div>
          </fieldset>
          <Field
            label="Industry" field="industry" shown={fields.industry} onField={onField} max={PROFILE_MAX.industry}
            placeholder="For example, food and drink" error={fieldError('industry')}
          />
          <TimeZoneField zone={zone} onChange={onZone} error={fieldError('timezone')} />
        </section>

        <YourAnswers answers={answers} onEdit={onEditAnswer} />

        {!hasLinkedin && !linkedinLater && <AddLinkedinCard onAdd={onLinkedin} onLater={onLinkedinLater} />}
      </div>
    </OnboardingShell>
  );
}
