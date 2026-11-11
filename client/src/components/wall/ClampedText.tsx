// A post's or a comment's words, cut to a few lines with "Show more" when they run longer (Shirley pilot S4). A post
// may be 8000 characters: drawn in full on a 360px phone it was dozens of screens, and the posts under it were lost.
//
// The cut is measured, not guessed from the length: the text is drawn clamped, and "Show more" appears only when its
// full height is taller than the clamp (it is measured again when the box changes width, so turning a phone sideways
// is right). A long word or address with no spaces breaks anywhere, so nothing scrolls sideways at 360px. A post a link
// names opens in full (`open`).

import { useLayoutEffect, useRef, useState } from 'react';
import Linkify from '@/components/ui/Linkify';
import { CLAMP_CLASS, overflowsClamp } from './wall-logic';

export default function ClampedText({ text, kind, open: openFromLink, className = '', testId }: {
  text: string;
  kind: keyof typeof CLAMP_CLASS;
  /** Drawn in full from the start (the post a ?post= link names). */
  open?: boolean;
  className?: string;
  testId?: string;
}) {
  const box = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(!!openFromLink);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    if (openFromLink) setExpanded(true);
  }, [openFromLink]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || expanded) return undefined;
    const measure = () => setCut(overflowsClamp(el.scrollHeight, el.clientHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [text, expanded]);

  return (
    <>
      <p
        ref={box}
        className={`min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${expanded ? '' : CLAMP_CLASS[kind]} ${className}`}
        data-testid={testId}
      >
        <Linkify text={text} />
      </p>
      {/* Measured while clamped, and kept while open, so "Show less" folds it back. */}
      {cut && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="min-h-[44px] px-0 text-xs font-semibold text-rsn-red hover:underline"
          data-testid={testId ? `${testId}-more` : undefined}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
