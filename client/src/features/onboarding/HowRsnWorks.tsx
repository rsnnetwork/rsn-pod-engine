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
//
// 26 Oct 2026, from Stefan and Claus's test of this client on 25 Oct: every card
// now opens with its heading and its words, then a line saying the examples are
// made up, then the picture. The people in the pictures are the made-up English
// ones in EXAMPLE_PEOPLE, each tagged "Example", with the sheep where their photo
// would be, so none can pass for a real member. Nothing is drawn above the heading.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Check, CalendarClock, Users, Sparkles } from 'lucide-react';
import { EXAMPLE_PEOPLE, type ExamplePerson } from '@rsn/shared';
import { Button } from '@/components/ui/Button';
import SheepAvatar, { type SheepPose } from '@/components/brand/SheepAvatar';

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

/** Said under every card's words, above its picture. */
const EXAMPLES_CAPTION = 'Examples only. These are not real members.';

interface Props {
  open: boolean;
  /** 'onboarding' records how it was left; 'replay' from Support does not. */
  mode: 'onboarding' | 'replay';
  onFinish: (outcome: 'completed' | 'skipped') => void;
}

/** One card: what it is called, what it does, a line saying its example is made up, and then the picture of it. */
export function TourSlide({ card }: { card: TourCard }) {
  return (
    <>
      <h2 className="text-center font-display text-xl font-bold text-[#1a1a2e]">{card.title}</h2>
      <p className="mt-2 text-center text-sm leading-relaxed text-gray-600">{card.body}</p>
      <p data-testid="tour-caption" className="mt-3 text-center text-xs font-medium text-gray-600">{EXAMPLES_CAPTION}</p>
      <div className="mt-4 flex justify-center">{card.visual}</div>
    </>
  );
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
        {/* A row as tall as Skip, so the heading below does not jump up when the last card has none. */}
        <div className="box-content flex min-h-[44px] shrink-0 items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] sm:pt-4">
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

// ── The pictures. The people in them are made up (EXAMPLE_PEOPLE): this is
//    shown to everyone, and a member's profile is theirs. Each is tagged
//    "Example" and has the sheep where a photo would be, so none can pass for a
//    real member. aria-hidden, because the card text and the caption above the
//    picture already say what it shows.

/** A word on the picture, not a colour: the made-up people are called what they are. */
function ExampleTag() {
  return (
    <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold leading-none text-gray-700">Example</span>
  );
}

/**
 * The picture's frame. A list picture (Matches, Meetings, Circles) is tagged as a whole, which keeps its rows
 * uncrowded; the person cards in Suggestions each carry their own tag.
 */
function Frame({ children, tagged = true }: { children: React.ReactNode; tagged?: boolean }) {
  return (
    <div
      aria-hidden
      data-testid="tour-picture"
      className="pointer-events-none w-full max-w-[280px] rounded-xl border border-gray-200 bg-gray-50 p-3"
    >
      {tagged && <div className="mb-2"><ExampleTag /></div>}
      {children}
    </div>
  );
}

/** Where a person's photo would be: the sheep, never a face. */
function Photo({ pose }: { pose: SheepPose }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100">
      <SheepAvatar pose={pose} size={30} />
    </span>
  );
}

/** One person on a Suggestions card: photo, name and role, and the tag. `dim` is the next suggestion, waiting. */
function PersonLine({ person, pose, dim = false }: { person: ExamplePerson; pose: SheepPose; dim?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <div className={`flex min-w-0 flex-1 items-start gap-2 ${dim ? 'opacity-60' : ''}`}>
        <Photo pose={pose} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-[#1a1a2e]">{person.name}</p>
          <p className="truncate text-[10px] text-gray-500">{person.role}</p>
        </div>
      </div>
      <ExampleTag />
    </div>
  );
}

// The pictures draw as many of the shared list as it has (two here, three below), never more: a list someone shortens
// shows fewer people and never blanks the tour, which every member sees right after onboarding. With nobody to tag,
// the frame itself says Example.
function SuggestionsMock() {
  const [first, second] = EXAMPLE_PEOPLE;
  return (
    <Frame tagged={!first}>
      <div className="rounded-lg border-2 border-rsn-red bg-white p-2.5">
        {first && <PersonLine person={first} pose="wave" />}
        <div className={`${first ? 'mt-2 ' : ''}rounded-md bg-rsn-red py-1.5 text-center text-[10px] font-medium text-white`}>
          I want to meet
        </div>
      </div>
      {second && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2.5">
          <PersonLine person={second} pose="listening" dim />
        </div>
      )}
    </Frame>
  );
}

/** The three states a match picture shows, for the first three people in the shared list. */
const MATCH_STATES: Array<{ pose: SheepPose; state: string; tone: string }> = [
  { pose: 'matched', state: 'Matched', tone: 'bg-emerald-100 text-emerald-700' },
  { pose: 'thinking', state: 'Asked, waiting', tone: 'bg-gray-100 text-gray-600' },
  { pose: 'wave', state: 'Wants to meet you', tone: 'bg-rsn-red-light text-rsn-red' },
];

function MatchesMock() {
  const rows = EXAMPLE_PEOPLE.slice(0, MATCH_STATES.length).map((person, i) => ({ person, ...MATCH_STATES[i] }));
  return (
    <Frame>
      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.person.name} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <Photo pose={r.pose} />
              <span className="truncate text-[11px] font-medium text-[#1a1a2e]">{r.person.name}</span>
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium ${r.tone}`}>{r.state}</span>
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
