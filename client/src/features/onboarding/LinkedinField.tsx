// ─── The member's own LinkedIn profile link ────────────────────────────────
//
// Screen 2's "Continue with LinkedIn" and screen 7's "Add LinkedIn" both end
// here (Ali, 21 Oct 2026: the member's own link goes through the existing
// lookup, which fills in role, company and industry; no LinkedIn app). The
// link they gave when they asked to join is already in the box. An empty box,
// or something plainly not a profile link, is answered at once; anything else
// goes to the server, whose refusal is shown here in its own words.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { linkedinInputProblem, onboardingError } from './flow';

interface Props {
  /** Prefilled: the link on their profile, as they would type it. */
  initial: string;
  submitLabel: string;
  /** Resolves when the link is saved; a rejection is shown under the box. */
  onSubmit: (url: string) => Promise<void>;
  /** Another choice is being sent (screen 2's "Continue with email"): this one waits. */
  disabled?: boolean;
}

export default function LinkedinField({ initial, submitLabel, onSubmit, disabled = false }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A double tap lands before React re-renders the button as disabled.
  const sending = useRef(false);

  // An empty box is waiting for them, so it takes the focus. A prefilled one does
  // not: on a phone the keyboard would cover the button they only need to press.
  useEffect(() => { if (!initial) input.current?.focus(); }, [initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending.current || disabled) return;
    const problem = linkedinInputProblem(value);
    if (problem) {
      setError(problem);
      input.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
    } catch (err) {
      setError(onboardingError(err, "We couldn't use that link. Please try again."));
      input.current?.focus();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="w-full">
      <label htmlFor={`${id}-url`} className="mb-1.5 block text-sm font-medium">Your LinkedIn profile link</label>
      <input
        id={`${id}-url`}
        ref={input}
        type="text"
        inputMode="url"
        autoComplete="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="linkedin.com/in/your-name"
        value={value}
        maxLength={500}
        onChange={e => { setValue(e.target.value); setError(null); }}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`h-12 w-full rounded-xl border bg-white px-3 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red sm:text-sm ${
          error ? 'border-rsn-red' : 'border-gray-300'
        }`}
      />
      {error && <p id={`${id}-error`} className="mt-1.5 text-sm text-rsn-red" role="alert">{error}</p>}
      <Button type="submit" isLoading={busy} disabled={disabled} className="mt-3 min-h-[48px] w-full">
        {submitLabel}
      </Button>
    </form>
  );
}
