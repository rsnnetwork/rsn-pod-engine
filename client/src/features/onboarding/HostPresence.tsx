import { motion } from 'framer-motion';

// The host "Reason" — no mascot, no bot. A living gradient presence built from
// layered CSS gradients + framer-motion (zero new deps): a soft glow that
// breathes, a slowly rotating conic core, a breathing inner mass, and a
// specular highlight. It intensifies while the host is "thinking". Kept as a
// swappable component so a richer hand-designed sequence (Lottie / Rive / WebGL)
// can drop into this same slot later.

interface HostPresenceProps {
  state?: 'idle' | 'thinking';
  /** Diameter in pixels. */
  size?: number;
  className?: string;
}

export default function HostPresence({ state = 'idle', size = 120, className = '' }: HostPresenceProps) {
  const thinking = state === 'thinking';

  return (
    <motion.div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 140, damping: 16, mass: 0.8 }}
      aria-hidden="true"
    >
      {/* soft outer glow */}
      <motion.div
        className="absolute inset-0 rounded-full blur-2xl"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(222,50,46,0.55), rgba(232,82,78,0.18) 60%, transparent 75%)',
        }}
        animate={{
          scale: thinking ? [1, 1.25, 1] : [1, 1.12, 1],
          opacity: thinking ? [0.7, 1, 0.7] : [0.5, 0.75, 0.5],
        }}
        transition={{ duration: thinking ? 1.8 : 4.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* rotating conic core */}
      <motion.div
        className="absolute rounded-full"
        style={{
          inset: '13%',
          background:
            'conic-gradient(from 0deg, #DE322E, #ff8a6d, #DE322E, #b3231f, #ff6a4d, #DE322E)',
          filter: 'blur(2px)',
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: thinking ? 7 : 16, repeat: Infinity, ease: 'linear' }}
      />
      {/* breathing inner mass */}
      <motion.div
        className="absolute rounded-full"
        style={{
          inset: '26%',
          background: 'radial-gradient(circle at 35% 30%, #ffffff, #ffd9d2 25%, #DE322E 78%)',
        }}
        animate={{ scale: thinking ? [1, 1.12, 1] : [1, 1.06, 1] }}
        transition={{ duration: thinking ? 1.3 : 3.2, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* specular highlight */}
      <motion.div
        className="absolute rounded-full bg-white/70 blur-md"
        style={{ width: '18%', height: '18%', top: '24%', left: '28%' }}
        animate={{ opacity: thinking ? [0.6, 1, 0.6] : [0.5, 0.8, 0.5] }}
        transition={{ duration: thinking ? 1.3 : 3.2, repeat: Infinity, ease: 'easeInOut' }}
      />
    </motion.div>
  );
}
