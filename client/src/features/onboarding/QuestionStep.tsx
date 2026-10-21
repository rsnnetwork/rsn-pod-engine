// One question, one screen (brief screens 3 to 6). Every question is this
// component: the options, the limit, the "Something else" box and Q2's
// "anything specific" box are all configuration from flow.ts, so the four
// screens cannot drift apart from each other.

import { useEffect, useId, useRef, type Ref } from 'react';
import type { OnboardingV2Answers } from '@rsn/shared';
import OptionTile from './OptionTile';
import { OWN_WORDS_MAX, SELF_GUESS_LINE, SPECIFIC, toggleKey, withKeys, withOwnWords, type Question } from './flow';

interface Props {
  question: Question;
  answers: OnboardingV2Answers;
  onChange: (next: OnboardingV2Answers) => void;
  /** "Tell us who you would like to meet." when "Something else" was left without words. */
  ownWordsError: string | null;
  /** A refusal about the question itself ("Select at least one answer."), or saving it failed: said under the options. */
  listError?: string | null;
  /** Q4: the answer was picked from their LinkedIn and is still the one ticked. */
  guessed: boolean;
  /** The "Something else" box, for the flow to focus when it asks for the words. */
  ownWordsRef?: Ref<HTMLInputElement>;
}

const FIELD = 'w-full rounded-xl border bg-white px-3 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red sm:text-sm';

export default function QuestionStep({ question: q, answers, onChange, ownWordsError, listError = null, guessed, ownWordsRef }: Props) {
  const id = useId();
  const errorLine = useRef<HTMLDivElement>(null);
  const listErrorLine = useRef<HTMLParagraphElement>(null);
  const selected: readonly string[] = answers[q.field];
  const atLimit = q.max !== null && selected.length >= q.max;
  const ownWordsOn = selected.includes(q.ownWordsKey);
  const words = answers[q.ownWordsField] ?? '';
  const specific = answers.findSpecific ?? '';

  // The words box is the last thing above the footer: its error would land below the fold, out of sight.
  useEffect(() => {
    if (ownWordsError) errorLine.current?.scrollIntoView({ block: 'nearest' });
  }, [ownWordsError]);
  useEffect(() => {
    if (listError) listErrorLine.current?.scrollIntoView({ block: 'nearest' });
  }, [listError]);

  return (
    <div>
      {guessed && (
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-sm text-amber-900" role="status">{SELF_GUESS_LINE}</p>
      )}

      <div role="group" aria-label={q.title} className="flex flex-col gap-2.5">
        {q.options.map(o => (
          <OptionTile
            key={o.key}
            label={o.label}
            selected={selected.includes(o.key)}
            // At the limit, the ones already chosen stay live, so a member can
            // swap one for another without first working out what to untick.
            disabled={atLimit && !selected.includes(o.key)}
            onToggle={() => onChange(withKeys(answers, q, toggleKey(selected, o.key, q.max)))}
          />
        ))}
      </div>

      {/* Right under "Something else", the last option, so the box reads as part of it. */}
      {ownWordsOn && (
        <div className="mt-3">
          <label htmlFor={`${id}-own`} className="mb-1.5 block text-sm font-medium">In your own words</label>
          <input
            id={`${id}-own`}
            ref={ownWordsRef}
            type="text"
            value={words}
            maxLength={OWN_WORDS_MAX}
            autoComplete="off"
            enterKeyHint="done"
            onChange={e => onChange(withOwnWords(answers, q, e.target.value))}
            aria-invalid={!!ownWordsError}
            aria-describedby={`${id}-own-count${ownWordsError ? ` ${id}-own-error` : ''}`}
            className={`h-12 ${FIELD} ${ownWordsError ? 'border-rsn-red' : 'border-gray-300'}`}
          />
          <div ref={errorLine} className="mt-1.5 flex items-start justify-between gap-3 text-xs">
            <span id={`${id}-own-error`} className="text-sm text-rsn-red" role={ownWordsError ? 'alert' : undefined}>{ownWordsError}</span>
            <span id={`${id}-own-count`} className="shrink-0 text-gray-500">{words.length}/{OWN_WORDS_MAX}</span>
          </div>
        </div>
      )}

      {atLimit && q.limitHint && (
        <p className="mt-3 text-center text-sm text-gray-600" role="status">{q.limitHint}</p>
      )}

      {listError && (
        <p ref={listErrorLine} className="mt-3 text-center text-sm text-rsn-red" role="alert">{listError}</p>
      )}

      {q.step === 'q2' && (
        <div className="mt-5">
          <label htmlFor={`${id}-specific`} className="mb-1.5 block text-sm font-medium">{SPECIFIC.label}</label>
          <textarea
            id={`${id}-specific`}
            value={specific}
            rows={3}
            maxLength={SPECIFIC.max}
            placeholder={SPECIFIC.placeholder}
            onChange={e => onChange({ ...answers, findSpecific: e.target.value })}
            aria-describedby={`${id}-specific-count`}
            className={`block resize-none py-2.5 leading-snug ${FIELD} border-gray-300`}
          />
          <p id={`${id}-specific-count`} className="mt-1.5 text-right text-xs text-gray-500">{specific.length}/{SPECIFIC.max}</p>
        </div>
      )}
    </div>
  );
}
