// ─── How REASON works ────────────────────────────────────────────────────────
//
// Shradha's deck, task 2: "A guided tour of the platform's value and core
// features, ending in a clear next step." The complaint it answers is that
// members were never told what the product is or how it works, and that after
// onboarding they were left with no guidance on next steps.
//
// Four cards, swiped or clicked, skippable, and re-openable later from Support.
// Each one explains a thing the member will actually see, in the deck's own
// words. The pictures are small mock-ups built from the real interface rather
// than screenshots, because everything they show is being redesigned this same
// week and a screenshot taken today would be wrong by Friday.
//
// 19 Oct 2026, the client's feedback on the preview: the pictures showed made-up
// people ("They confuse people"), so nobody is in them any more: where a person
// would be there is the sheep, and where their words would be there is a grey
// bar. The heading and the description now come first and the picture under
// them, and finishing the tour (OnboardingTour) lands on For You.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import ReasonSheep, { type ReasonSheepPose } from '@/features/reason/brand/ReasonSheep';

export interface TourCard {
  title: string;
  body: string;
  visual: JSX.Element;
}

/** The deck's copy, verbatim, except card 1: it names the screen and the button the REASON preview shows (For You, Meet). */
export const TOUR_CARDS: TourCard[] = [
  {
    title: 'For You',
    body: "We suggest people who match your intent. Tap 'Meet' to ask.",
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
  /** The server did not record the last press of Skip or the last button. */
  failed?: boolean;
  onFinish: (outcome: 'completed' | 'skipped') => void;
}

/** One card: what it is called, what it does, and then the picture of it. */
export function TourSlide({ card }: { card: TourCard }) {
  return (
    <>
      <h2 className="text-center font-display text-xl font-bold text-[#1a1a2e]">{card.title}</h2>
      <p className="mt-2 text-balance text-center text-sm leading-relaxed text-gray-600">{card.body}</p>
      <div className="mt-5 flex justify-center">{card.visual}</div>
    </>
  );
}

export default function HowRsnWorks({ open, mode, failed = false, onFinish }: Props) {
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
        aria-label="How REASON works"
        data-testid="how-rsn-works"
        className="flex h-[100dvh] w-full flex-col bg-white sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-2xl"
      >
        {/* A row as tall as Skip, so the card does not jump up when the last one has none. */}
        <div className="box-content flex min-h-[44px] shrink-0 items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] sm:pt-4">
          <p className="text-sm font-semibold text-[#1a1a2e]">How REASON works</p>
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
                <TourSlide card={TOUR_CARDS[index]} />
              </motion.div>
            </AnimatePresence>
            <span className="sr-only" aria-live="polite">
              Card {index + 1} of {TOUR_CARDS.length}, {TOUR_CARDS[index].title}
            </span>
          </div>
        </div>

        <div className="shrink-0 border-t border-gray-100 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
          {/* Inside the dialog: a toast would sit over Skip on a phone, and a screen reader in a modal does not read what is outside it. */}
          {failed && (
            <p role="alert" className="mb-2 text-center text-sm font-medium text-red-700">
              {"We couldn't save that. Please try again."}
            </p>
          )}
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
              {last ? (mode === 'replay' ? 'Done' : 'See my matches') : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── The pictures. Nobody is in them: this is shown to everyone, a member's
//    profile is theirs, and the client found made-up people confusing. Where a
//    person would be there is the sheep; where their words would be, a grey
//    bar. The only words are the labels the product itself shows. aria-hidden,
//    because the card text already says what they show.

/** Where a person's photo would be: a soft tile, with the sheep standing in it. */
function Tile({ children, round = false }: { children: React.ReactNode; round?: boolean }) {
  return (
    <span className={`flex h-10 w-10 shrink-0 items-center justify-center bg-gray-100 ${round ? 'rounded-full' : 'rounded-lg'}`}>
      {children}
    </span>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      data-testid="tour-picture"
      // One height for every card, so on a desktop the dialog does not grow and shrink under the pointer that is
      // pressing Next. A minimum: a larger text size makes it taller and never clips it.
      className="pointer-events-none flex min-h-[240px] w-full max-w-[320px] flex-col justify-center rounded-2xl border border-gray-200 bg-gray-50 p-3"
    >
      {children}
    </div>
  );
}

/** Where a line of someone's words would be. */
function Bar({ className, strong = false }: { className: string; strong?: boolean }) {
  return <span className={`block h-2 rounded-full ${strong ? 'bg-gray-300' : 'bg-gray-200'} ${className}`} />;
}

function SuggestionsMock() {
  return (
    <Frame>
      <div className="rounded-xl border-2 border-rsn-red bg-white p-3">
        <div className="flex items-center gap-3">
          <Tile><ReasonSheep pose="curious" className="h-9 w-9" /></Tile>
          <div className="min-w-0 flex-1 space-y-2">
            <Bar strong className="w-3/4" />
            <Bar className="w-1/2" />
          </div>
        </div>
        <div className="mt-2.5 space-y-1.5">
          <Bar className="w-full" />
          <Bar className="w-4/5" />
        </div>
        <div className="mt-2.5 rounded-lg bg-rsn-red py-2 text-center text-xs font-bold text-white">Meet</div>
      </div>
      <div className="mt-2 flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-2.5 opacity-60">
        <Tile><ReasonSheep pose="thinking" className="h-9 w-9" /></Tile>
        <div className="min-w-0 flex-1 space-y-2">
          <Bar strong className="w-2/3" />
          <Bar className="w-2/5" />
        </div>
      </div>
    </Frame>
  );
}

function MatchesMock() {
  const rows: Array<{ pose: ReasonSheepPose; name: string; state: string; tone: string }> = [
    { pose: 'match', name: 'w-4/5', state: 'Matched', tone: 'bg-emerald-100 text-emerald-800' },
    { pose: 'curious', name: 'w-3/5', state: 'Wants to meet you', tone: 'bg-rsn-red-light text-rsn-red-hover' },
    { pose: 'thinking', name: 'w-2/3', state: 'Request sent', tone: 'bg-gray-100 text-gray-600' },
  ];
  return (
    <Frame>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.state} className="flex items-center gap-2.5 rounded-xl bg-white p-2.5">
            <Tile><ReasonSheep pose={r.pose} className="h-9 w-9" /></Tile>
            <div className="min-w-0 flex-1">
              <Bar strong className={r.name} />
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${r.tone}`}>{r.state}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function MeetingsMock() {
  return (
    <Frame>
      <div className="grid grid-cols-3 gap-2">
        {/* The one in the middle is the green slot, the time both of them can do. */}
        {['9:00', '9:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '1:00'].map((t, i) => (
          <div
            key={t}
            className={`flex flex-col items-center justify-center rounded-lg py-2 text-center text-[11px] font-medium ${
              i === 4 ? 'border border-emerald-400 bg-emerald-100 text-emerald-800' : 'border border-gray-200 bg-white text-gray-500'
            }`}
          >
            {t}
            {i === 4 && <span className="block text-[10px] font-semibold">Both can</span>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-2">
        <ReasonSheep pose="hopeful" className="h-8 w-8 shrink-0" />
        <span className="text-[11px] font-semibold text-emerald-800">Meeting confirmed · Join</span>
      </div>
    </Frame>
  );
}

function CirclesMock() {
  const circles: Array<{ pose: ReasonSheepPose; name: string }> = [
    { pose: 'hopeful', name: 'Founders' },
    { pose: 'match', name: 'Investors' },
  ];
  const join = <span className="shrink-0 rounded-full bg-rsn-red-light px-3 py-1 text-[11px] font-semibold text-rsn-red-hover">Join</span>;
  return (
    <Frame>
      <div className="space-y-2">
        {circles.map((c) => (
          <div key={c.name} className="flex items-center gap-2.5 rounded-xl bg-white p-2.5">
            <Tile round><ReasonSheep pose={c.pose} className="h-9 w-9" /></Tile>
            <div className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-[#1a1a2e]">{c.name}</span>
              <Bar className="mt-1.5 w-2/3" />
            </div>
            {join}
          </div>
        ))}
        <div className="flex items-center gap-2.5 rounded-xl bg-white p-2.5">
          <Tile round>
            <CalendarClock className="h-5 w-5 text-gray-500" />
          </Tile>
          <div className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-[#1a1a2e]">Networking event</span>
            <Bar className="mt-1.5 w-1/2" />
          </div>
          {join}
        </div>
      </div>
    </Frame>
  );
}
