// ─── How RSN works ───────────────────────────────────────────────────────────
//
// Shradha's deck, task 2: "A guided tour of the platform's value and core
// features, ending in a clear next step." The complaint it answers is
// "Users are never told what RSN is or how it works" and "after onboarding,
// users are left with no guidance on next steps."
//
// Four cards, swiped or clicked, skippable, and re-openable later from Support.
// Each one explains a thing the member will actually see, in the deck's own
// words. The pictures are small mock-ups built from the real interface rather
// than screenshots, because everything they show is being redesigned this same
// week and a screenshot taken today would be wrong by Friday.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Check, CalendarClock, Users, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import SheepAvatar from '@/components/brand/SheepAvatar';

export interface TourCard {
  title: string;
  body: string;
  visual: JSX.Element;
}

/** The deck's copy, verbatim. */
export const TOUR_CARDS: TourCard[] = [
  {
    title: 'Suggestions',
    body: "We suggest people who match your intent. Tap 'I want to meet' to ask.",
    visual: <SuggestionsMock />,
  },
  {
    title: 'Matches',
    body: "When they want to meet you too, it's a match - you'll see it here and in chat.",
    visual: <MatchesMock />,
  },
  {
    title: 'Meetings',
    body: 'Share your availability, pick a green slot - we create the meeting with a link.',
    visual: <MeetingsMock />,
  },
  {
    title: 'Circles & events',
    body: 'Join circles of people who share your intent, and networking events.',
    visual: <CirclesMock />,
  },
];

interface Props {
  open: boolean;
  /** 'onboarding' records how it was left; 'replay' from Support does not. */
  mode: 'onboarding' | 'replay';
  onFinish: (outcome: 'completed' | 'skipped') => void;
}

export default function HowRsnWorks({ open, mode, onFinish }: Props) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const still = useReducedMotion();

  const last = index === TOUR_CARDS.length - 1;
  const go = (next: number) => {
    setDirection(next > index ? 1 : -1);
    setIndex(Math.max(0, Math.min(TOUR_CARDS.length - 1, next)));
  };

  // Escape skips, arrows move, and focus is kept inside while it is open.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onFinish('skipped'); return; }
      if (e.key === 'ArrowRight') { go(index + 1); return; }
      if (e.key === 'ArrowLeft') { go(index - 1); return; }
      if (e.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, index, onFinish]);

  if (!open) return null;

  // Portalled to the body: a fixed overlay inside an animated ancestor resolves
  // against that ancestor's transform instead of the window, which is how an
  // earlier modal ended up half off the screen.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="How RSN works"
        data-testid="how-rsn-works"
        className="flex h-[100dvh] w-full flex-col bg-white sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] sm:pt-4">
          <p className="text-sm font-semibold text-[#1a1a2e]">How RSN works</p>
          {!last && (
            <button
              type="button"
              onClick={() => onFinish('skipped')}
              className="-mr-2 min-h-[44px] rounded-lg px-3 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            >
              Skip
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto flex max-w-sm flex-col items-center">
            <SheepAvatar pose={last ? 'matched' : 'welcome'} size={72} className="mb-3" />
            <AnimatePresence mode="wait" custom={direction}>
              <motion.div
                key={index}
                custom={direction}
                initial={still ? { opacity: 0 } : { opacity: 0, x: direction * 40 }}
                animate={still ? { opacity: 1 } : { opacity: 1, x: 0 }}
                exit={still ? { opacity: 0 } : { opacity: 0, x: direction * -40 }}
                transition={{ duration: 0.22 }}
                drag={still ? false : 'x'}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.18}
                dragDirectionLock
                style={{ touchAction: 'pan-y' }}
                onDragEnd={(_e, info) => {
                  if (info.offset.x < -60 || info.velocity.x < -400) go(index + 1);
                  else if (info.offset.x > 60 || info.velocity.x > 400) go(index - 1);
                }}
                className="w-full"
                role="group"
                aria-roledescription="slide"
                aria-label={`${index + 1} of ${TOUR_CARDS.length}: ${TOUR_CARDS[index].title}`}
              >
                <div className="mb-4 flex justify-center">{TOUR_CARDS[index].visual}</div>
                <h2 className="text-center font-display text-xl font-bold text-[#1a1a2e]">
                  {TOUR_CARDS[index].title}
                </h2>
                <p className="mt-2 text-center text-sm leading-relaxed text-gray-600">
                  {TOUR_CARDS[index].body}
                </p>
              </motion.div>
            </AnimatePresence>
            <span className="sr-only" aria-live="polite">
              Card {index + 1} of {TOUR_CARDS.length}, {TOUR_CARDS[index].title}
            </span>
          </div>
        </div>

        <div className="shrink-0 border-t border-gray-100 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
          <div className="mb-3 flex justify-center gap-1">
            {TOUR_CARDS.map((c, i) => (
              <button
                key={c.title}
                type="button"
                onClick={() => go(i)}
                aria-label={`Go to card ${i + 1}: ${c.title}`}
                aria-current={i === index ? 'step' : undefined}
                className="flex h-11 w-11 items-center justify-center"
              >
                <span className={`h-2 rounded-full transition-all ${i === index ? 'w-6 bg-rsn-red' : 'w-2 bg-gray-300'}`} />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => go(index - 1)}
              // invisible rather than absent, so the primary button never moves
              className={`min-h-[48px] rounded-xl px-4 text-sm font-medium text-gray-600 hover:bg-gray-100 ${index === 0 ? 'invisible' : ''}`}
            >
              Back
            </button>
            <Button
              onClick={() => (last ? onFinish('completed') : go(index + 1))}
              className="min-h-[48px] flex-1"
            >
              {last ? (mode === 'replay' ? 'Done' : 'See my suggestions') : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── The pictures. Fictional people, never real members: this is shown to
//    everyone, and a member's profile is theirs. aria-hidden, because the card
//    text already says what they show.

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div aria-hidden className="pointer-events-none w-full max-w-[280px] rounded-xl border border-gray-200 bg-gray-50 p-3">
      {children}
    </div>
  );
}

function SuggestionsMock() {
  return (
    <Frame>
      <div className="rounded-lg border-2 border-rsn-red bg-white p-2.5">
        <p className="text-xs font-semibold text-[#1a1a2e]">Amara Okafor</p>
        <p className="text-[10px] text-gray-500">Founder · Northwind</p>
        <div className="mt-2 rounded-md bg-rsn-red py-1.5 text-center text-[10px] font-medium text-white">
          I want to meet
        </div>
      </div>
      <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2.5 opacity-60">
        <p className="text-xs font-semibold text-[#1a1a2e]">Tomas Lind</p>
        <p className="text-[10px] text-gray-500">Investor · Baltic Seed</p>
      </div>
    </Frame>
  );
}

function MatchesMock() {
  const rows = [
    { name: 'Amara Okafor', state: 'Matched', tone: 'bg-emerald-100 text-emerald-700' },
    { name: 'Tomas Lind', state: 'Asked, waiting', tone: 'bg-gray-100 text-gray-600' },
    { name: 'Priya Raman', state: 'Wants to meet you', tone: 'bg-rsn-red-light text-rsn-red' },
  ];
  return (
    <Frame>
      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.name} className="flex items-center justify-between rounded-lg bg-white px-2.5 py-2">
            <span className="text-[11px] font-medium text-[#1a1a2e]">{r.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${r.tone}`}>{r.state}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function MeetingsMock() {
  return (
    <Frame>
      <div className="grid grid-cols-3 gap-1.5">
        {['9:00', '9:30', '10:00', '10:30', '11:00', '11:30'].map((t, i) => (
          <div
            key={t}
            className={`rounded-md py-1.5 text-center text-[9px] font-medium ${
              i === 4 ? 'border border-emerald-400 bg-emerald-100 text-emerald-700' : 'border border-gray-200 bg-white text-gray-500'
            }`}
          >
            {t}
            {i === 4 && <span className="block text-[8px]">Both can</span>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2">
        <CalendarClock className="h-3 w-3 shrink-0 text-emerald-600" />
        <span className="text-[10px] font-medium text-emerald-800">Meeting confirmed · Join</span>
      </div>
    </Frame>
  );
}

function CirclesMock() {
  return (
    <Frame>
      <div className="space-y-1.5">
        {[
          { icon: <Users className="h-3 w-3" />, name: 'Founders', meta: '8 members' },
          { icon: <Sparkles className="h-3 w-3" />, name: 'AI Developers', meta: '2 members' },
        ].map(c => (
          <div key={c.name} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-2">
            <span className="text-gray-400">{c.icon}</span>
            <span className="flex-1 text-[11px] font-medium text-[#1a1a2e]">{c.name}</span>
            <span className="rounded-full bg-rsn-red-light px-2 py-0.5 text-[9px] font-medium text-rsn-red">Join</span>
          </div>
        ))}
        <div className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-2">
          <Check className="h-3 w-3 text-emerald-500" />
          <span className="flex-1 text-[11px] font-medium text-[#1a1a2e]">Thursday networking</span>
        </div>
      </div>
    </Frame>
  );
}
