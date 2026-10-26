// One question, one screen (brief screens 3 to 6). Every question is this
// component: the options, the "Something else" box and Q2's "anything specific"
// box are all configuration from flow.ts, so the four screens cannot drift
// apart from each other. Every question takes all the answers that apply.

import { useEffect, useId, useRef, type Ref } from 'react';
import type { OnboardingV2Answers } from '@rsn/shared';
import OptionTile from './OptionTile';
import { FROM_LINKEDIN, OWN_WORDS_MAX, SELF_GUESS_LINE, SPECIFIC, toggleKey, withKeys, withOwnWords, type Question } from './flow';

interface Props {
  question: Question;
  answers: OnboardingV2Answers;
  onChange: (next: OnboardingV2Answers) => void;
  /** "Tell us who you would like to meet." when "Something else" was left without words. */
  ownWordsError: string | null;
  /** A refusal about the question itself ("Select at least one answer."), or saving it failed: said under the options. */
  listError?: string | null;
  /**
   * Q4: the answers LinkedIn picked, which stay marked (a note on each tile, the line above them) until the member moves on.
   * A tap changes what is ticked and never what is drawn, so nothing moves under a finger.
   */
  fromLinkedin: readonly string[];
  /** The "Something else" box, for the flow to focus when it asks for the words. */
  ownWordsRef?: Ref<HTMLInputElement>;
  /** The id of the helper line above ("Select all that apply."), which describes the options. */
  hintId?: string;
}

const FIELD = 'w-full rounded-xl border bg-white px-3 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red sm:text-sm';

export default function QuestionStep({ question: q, answers, onChange, ownWordsError, listError = null, fromLinkedin, ownWordsRef, hintId }: Props) {
  const id = useId();
  const errorLine = useRef<HTMLDivElement>(null);
  const listErrorLine = useRef<HTMLParagraphElement>(null);
  // A box and its counter are one block: focusing the box brings the whole block into view, not the box alone.
  const wordsBlock = useRef<HTMLDivElement>(null);
  const specificBlock = useRef<HTMLDivElement>(null);
  const selected: readonly string[] = answers[q.field];
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
      {fromLinkedin.length > 0 && (
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-sm text-amber-900" role="status">{SELF_GUESS_LINE}</p>
      )}

      <div
        role="group"
        aria-label={q.title}
        // The helper line, and the error when it shows, are what a screen reader says next.
        aria-describedby={[hintId, listError ? `${id}-list-error` : null].filter(Boolean).join(' ') || undefined}
        className="flex flex-col gap-2.5"
      >
        {q.options.map(o => (
          <OptionTile
            key={o.key}
            label={o.label}
            selected={selected.includes(o.key)}
            note={fromLinkedin.includes(o.key) ? FROM_LINKEDIN : undefined}
            onToggle={() => onChange(withKeys(answers, q, toggleKey(selected, o.key)))}
          />
        ))}
      </div>

      {/* Right under "Something else", the last option, so the box reads as part of it. */}
      {ownWordsOn && (
        <div ref={wordsBlock} className="mt-3">
          <label htmlFor={`${id}-own`} className="mb-1.5 block text-sm font-medium">In your own words</label>
          <input
            id={`${id}-own`}
            ref={ownWordsRef}
            type="text"
            value={words}
            maxLength={OWN_WORDS_MAX}
            autoComplete="off"
            enterKeyHint="done"
            // The browser reveals the box alone (WebKit does not scroll for a script's focus() at all), which can leave its counter under the footer.
            onFocus={() => wordsBlock.current?.scrollIntoView({ block: 'nearest' })}
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

      {listError && (
        <p ref={listErrorLine} id={`${id}-list-error`} className="mt-3 text-center text-sm text-rsn-red" role="alert">{listError}</p>
      )}

      {q.step === 'q2' && (
        <div ref={specificBlock} className="mt-5">
          <label htmlFor={`${id}-specific`} className="mb-1.5 block text-sm font-medium">{SPECIFIC.label}</label>
          <textarea
            id={`${id}-specific`}
            value={specific}
            rows={3}
            maxLength={SPECIFIC.max}
            placeholder={SPECIFIC.placeholder}
            onFocus={() => specificBlock.current?.scrollIntoView({ block: 'nearest' })}
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
