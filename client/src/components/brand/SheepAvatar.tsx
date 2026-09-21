// ─── The sheep ───────────────────────────────────────────────────────────────
//
// Shradha's deck, task 3: "Replace the red dot face everywhere with the black
// sheep - wave, listening, matched." The red disc was never a regression — it
// was built on 10 Sep because Claus had ruled out a mascot in June and then
// asked for a cartoon face. The deck reverses that again.
//
// The poses in the deck are 241x327 crops off a contact sheet, on white, with
// their captions printed into the image, and there is no idle pose at all —
// none of them can ship. So this draws the black sheep the product already
// owns (client/public/rsn-sheep.png, 1920x1460 with transparency) and gives it
// the movement each moment needs. When the real pose set arrives, only the
// POSES map below changes; every screen keeps calling this the same way.
//
// Props are deliberately the same shape HostPresence had, so swapping it out
// was a one-line change per call site.

import { motion, useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion';

/** Served from public/, so it is a URL rather than a bundled import. */
const SHEEP_SRC = '/rsn-sheep.png';

export type SheepPose = 'idle' | 'wave' | 'listening' | 'thinking' | 'welcome' | 'matched';

interface Props {
  pose?: SheepPose;
  /** Box size in px. The art is drawn to fit inside it, whatever its shape. */
  size?: number;
  className?: string;
}

/**
 * How each moment moves. Written as whole-body motion because one flat image
 * has no arm to raise on its own: a wave is a lean and a tilt, not a limb.
 * The deck's direction rule is "readable with the sound off — clear beginning,
 * readable intention, clean return to idle", which is what these aim at.
 */
const POSES: Record<SheepPose, { animate: TargetAndTransition; transition: Transition; label: string }> = {
  idle: {
    animate: { y: [0, -3, 0], rotate: 0, scale: 1 },
    transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' },
    label: 'RSN',
  },
  wave: {
    // Once, clearly, then still — never a loop, so it reads as a greeting
    // rather than a spinner.
    animate: { rotate: [0, -9, 7, -5, 0], y: [0, -8, 0, -4, 0] },
    transition: { duration: 1.6, ease: 'easeInOut', times: [0, 0.25, 0.5, 0.75, 1] },
    label: 'Hello',
  },
  listening: {
    // Still body, the occasional nod. Calm: nothing bouncing while someone
    // is trying to answer a question.
    animate: { rotate: [0, 2.5, 0, 0, 0], y: [0, 2, 0, 0, 0] },
    transition: { duration: 5, repeat: Infinity, ease: 'easeInOut', times: [0, 0.1, 0.2, 0.6, 1] },
    label: 'Listening',
  },
  thinking: {
    animate: { rotate: [0, -3, 0, 3, 0], y: [0, -2, 0, -2, 0] },
    transition: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' },
    label: 'Thinking',
  },
  welcome: {
    animate: { scale: [1, 1.04, 1], y: [0, -5, 0] },
    transition: { duration: 3, repeat: Infinity, ease: 'easeInOut' },
    label: 'Welcome',
  },
  matched: {
    // A visible lift, then settle. Joyful, not hyperactive.
    animate: { y: [0, -16, 0, -8, 0], scale: [1, 1.06, 1, 1.03, 1], rotate: [0, -4, 4, -2, 0] },
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
        src={SHEEP_SRC}
        alt=""
        width={size}
        height={size}
        // The art is wider than it is tall; contain keeps it whole in a square
        // box so no call site has to know its shape.
        className="h-full w-full object-contain"
        draggable={false}
        {...motionProps}
      />
    </motion.div>
  );
}
