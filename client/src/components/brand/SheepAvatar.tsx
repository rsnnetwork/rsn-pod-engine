// ─── The sheep ───────────────────────────────────────────────────────────────
//
// Shradha's deck, task 3: "Replace the red dot face everywhere with the black
// sheep - wave, listening, matched." The red disc was never a regression — it
// was built on 10 Sep because Claus had ruled out a mascot in June and then
// asked for a cartoon face. The deck reverses that again.
//
// 22 Sep 2026: the real pose set arrived (RSN-Sheep-Delivery.zip) — six
// transparent cut-outs named exactly as this component's poses already were,
// so nothing above had to change. They ship from client/public/sheep at 384px,
// which covers the largest use (112 CSS px) on a 3x phone; the ~900px masters
// and the 18-pose sheet stay in the delivery, not the bundle.
//
// The motion changed with them. While there was one silhouette for every
// moment, movement had to carry the whole meaning — a wave was a lean and a
// tilt, because a flat shape has no arm to raise. Each pose now says what it
// means on its own, so the movement only has to breathe: anything bigger
// fights the drawing. The deck's rule still holds — "readable with the sound
// off, clear beginning, readable intention, clean return to idle".
//
// Props are deliberately the same shape HostPresence had, so swapping it out
// was a one-line change per call site.

import { motion, useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion';

export type SheepPose = 'idle' | 'wave' | 'listening' | 'thinking' | 'welcome' | 'matched';

/** Served from public/, so these are URLs rather than bundled imports. */
const SRC: Record<SheepPose, string> = {
  idle: '/sheep/idle.png',
  wave: '/sheep/wave.png',
  listening: '/sheep/listening.png',
  thinking: '/sheep/thinking.png',
  welcome: '/sheep/welcome.png',
  matched: '/sheep/matched.png',
};

interface Props {
  pose?: SheepPose;
  /** Box size in px. The art is drawn to fit inside it, whatever its shape. */
  size?: number;
  className?: string;
}

/**
 * How each moment breathes. The pose art carries the intention; these only
 * keep it alive. A one-shot moment (a greeting, a match) plays once and
 * settles — never a loop, which would read as a spinner.
 */
const POSES: Record<SheepPose, { animate: TargetAndTransition; transition: Transition; label: string }> = {
  idle: {
    animate: { y: [0, -3, 0] },
    transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' },
    label: 'RSN',
  },
  wave: {
    // The arm is already up in the art, so this is only the body behind it.
    animate: { rotate: [0, -3, 2, -1.5, 0], y: [0, -5, 0, -2, 0] },
    transition: { duration: 1.6, ease: 'easeInOut', times: [0, 0.25, 0.5, 0.75, 1] },
    label: 'Hello',
  },
  listening: {
    // Eyes are closed and the head is tilted in the art. Nothing should bounce
    // while someone is trying to answer a question.
    animate: { y: [0, -2, 0] },
    transition: { duration: 5, repeat: Infinity, ease: 'easeInOut' },
    label: 'Listening',
  },
  thinking: {
    animate: { rotate: [0, -1.5, 0, 1.5, 0], y: [0, -2, 0, -2, 0] },
    transition: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' },
    label: 'Thinking',
  },
  welcome: {
    animate: { scale: [1, 1.03, 1], y: [0, -4, 0] },
    transition: { duration: 3, repeat: Infinity, ease: 'easeInOut' },
    label: 'Welcome',
  },
  matched: {
    // A lift, then settle. Joyful, not hyperactive.
    animate: { y: [0, -12, 0, -5, 0], scale: [1, 1.04, 1, 1.02, 1] },
    transition: { duration: 1.5, ease: 'easeOut' },
    label: 'Matched',
  },
};

export default function SheepAvatar({ pose = 'idle', size = 112, className = '' }: Props) {
  // Someone who has asked their system not to animate things gets the sheep
  // standing still, not a jittering one.
  const still = useReducedMotion();
  const motionProps = still
    ? {}
    : { animate: POSES[pose].animate, transition: POSES[pose].transition };

  return (
    <motion.div
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
      initial={still ? false : { scale: 0.85, opacity: 0 }}
      animate={still ? undefined : { scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 170, damping: 18 }}
      data-testid="sheep-avatar"
      data-pose={pose}
      aria-hidden="true"
    >
      <motion.img
        // Keyed on the pose so React swaps the element rather than mutating
        // src on the live one, which showed the previous pose until the next
        // decoded — the sheep appeared to answer a beat late.
        key={pose}
        src={SRC[pose]}
        alt=""
        width={size}
        height={size}
        // The art is taller than it is wide; contain keeps it whole in a square
        // box so no call site has to know its shape.
        className="h-full w-full object-contain"
        draggable={false}
        {...motionProps}
      />
    </motion.div>
  );
}