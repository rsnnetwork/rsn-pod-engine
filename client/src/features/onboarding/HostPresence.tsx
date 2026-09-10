import { motion } from 'framer-motion';

// The host "Reason" as an RSN emoji (Stefan + Claus, 10 Sep 2026: the blinking
// red dot felt like a status light; they asked for something like an avatar,
// not a usual one, a cartoonish face with small eyes, a nose and lips). A solid
// brand-red disc, like an emoji, with the features drawn on it. Pure SVG +
// framer-motion, no assets, scales to any size. It blinks now and then, and
// while the host is "thinking" it looks up a little and its mouth moves as if
// about to speak. Same props as before, so every surface that showed the dot
// (header, welcome modal, searching / confirm / fallback screens) shows the face.

interface HostPresenceProps {
  state?: 'idle' | 'thinking';
  /** Diameter in pixels. */
  size?: number;
  className?: string;
}

const INK = '#1a1a2e';

export default function HostPresence({ state = 'idle', size = 120, className = '' }: HostPresenceProps) {
  const thinking = state === 'thinking';
  // Eyes look up and to the side while thinking, straight ahead otherwise.
  const gaze = thinking ? { x: 1.5, y: -1.5 } : { x: 0, y: 0 };

  return (
    <motion.div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1, y: thinking ? [0, -1.5, 0] : 0 }}
      transition={{
        scale: { type: 'spring', stiffness: 160, damping: 16 },
        opacity: { duration: 0.3 },
        y: { duration: 1.6, repeat: thinking ? Infinity : 0, ease: 'easeInOut' },
      }}
      aria-hidden="true"
      data-testid="host-face"
    >
      <svg viewBox="0 0 100 100" width={size} height={size} role="presentation">
        <defs>
          <radialGradient id="host-face-red" cx="36%" cy="30%" r="78%">
            <stop offset="0%" stopColor="#ff8f7d" />
            <stop offset="55%" stopColor="#ea4a44" />
            <stop offset="100%" stopColor="#b8231f" />
          </radialGradient>
        </defs>

        {/* the emoji disc */}
        <circle cx="50" cy="50" r="47" fill="url(#host-face-red)" />
        {/* soft highlight, like a glossy emoji */}
        <ellipse cx="38" cy="30" rx="16" ry="10" fill="#fff" opacity="0.14" />

        {/* eyes: small, blink every few seconds (scaleY), drift while thinking */}
        <motion.g animate={{ x: gaze.x, y: gaze.y }} transition={{ duration: 0.4 }}>
          <motion.ellipse
            cx="36" cy="42" rx="4" ry="5" fill={INK}
            style={{ transformOrigin: '36px 42px' }}
            animate={{ scaleY: [1, 1, 0.08, 1, 1] }}
            transition={{ duration: 4.2, times: [0, 0.62, 0.66, 0.7, 1], repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.ellipse
            cx="64" cy="42" rx="4" ry="5" fill={INK}
            style={{ transformOrigin: '64px 42px' }}
            animate={{ scaleY: [1, 1, 0.08, 1, 1] }}
            transition={{ duration: 4.2, times: [0, 0.62, 0.66, 0.7, 1], repeat: Infinity, ease: 'easeInOut' }}
          />
          {/* eye highlights */}
          <circle cx="37.5" cy="40.4" r="1.3" fill="#fff" />
          <circle cx="65.5" cy="40.4" r="1.3" fill="#fff" />
        </motion.g>

        {/* nose: one small curve */}
        <path d="M49 50 q-3 6 2 7" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" opacity="0.8" />

        {/* lips: a small smile; while thinking they move as if about to speak */}
        <motion.path
          fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round"
          animate={{
            d: thinking
              ? ['M40 66 q10 7 20 0', 'M42 67 q8 3 16 0', 'M43 66 q7 8 14 0', 'M40 66 q10 7 20 0']
              : 'M40 66 q10 7 20 0',
          }}
          transition={{ duration: 1.4, repeat: thinking ? Infinity : 0, ease: 'easeInOut' }}
        />
        <path d="M43 66 q7 -3 14 0" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
      </svg>
    </motion.div>
  );
}
