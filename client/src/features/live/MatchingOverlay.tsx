import { useEffect, useState } from 'react';
import { Shuffle, CheckCircle2 } from 'lucide-react';

interface Props {
  roomCount: number;
  roundNumber: number;
}

export default function MatchingOverlay({ roomCount, roundNumber }: Props) {
  const [phase, setPhase] = useState<'matching' | 'result'>('matching');

  useEffect(() => {
    const timer = setTimeout(() => setPhase('result'), 1800);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/95 backdrop-blur-sm">
      <div className="text-center space-y-6 px-6">

        {phase === 'matching' ? (
          <>
            {/* Animated connecting nodes */}
            <div className="relative mx-auto w-32 h-32">
              {/* Outer ring pulse */}
              <div className="absolute inset-0 rounded-full border-2 border-rsn-red/20 animate-ping" />
              <div className="absolute inset-2 rounded-full border border-rsn-red/10 animate-ping" style={{ animationDelay: '0.5s' }} />

              {/* Center icon */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-rsn-red/10 flex items-center justify-center">
                  <Shuffle className="h-7 w-7 text-rsn-red" />
                </div>
              </div>

              {/* Orbiting dots */}
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div
                  key={i}
                  className="absolute w-3 h-3 rounded-full bg-rsn-red/60"
                  style={{
                    top: `${50 + 42 * Math.sin((i * Math.PI * 2) / 6)}%`,
                    left: `${50 + 42 * Math.cos((i * Math.PI * 2) / 6)}%`,
                    transform: 'translate(-50%, -50%)',
                    animation: `pulse 1.5s ease-in-out infinite`,
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ))}
            </div>

            <div>
              <h2 className="text-xl font-semibold text-gray-800">Matching people...</h2>
              <p className="text-sm text-gray-400 mt-1">Finding the best connections for Round {roundNumber}</p>
            </div>

            {/* Animated progress dots */}
            <div className="flex items-center justify-center gap-2">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-rsn-red/70"
                  style={{
                    animation: 'bounce 1s ease-in-out infinite',
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            {/* Success state */}
            <div className="relative mx-auto w-20 h-20">
              <div className="absolute inset-0 rounded-full bg-emerald-100 animate-ping opacity-40" />
              <div className="relative flex items-center justify-center w-20 h-20 rounded-full bg-emerald-50">
                <CheckCircle2 className="h-10 w-10 text-emerald-500" />
              </div>
            </div>

            <div>
              <h2 className="text-xl font-semibold text-gray-800">
                {roomCount} breakout room{roomCount !== 1 ? 's' : ''} created!
              </h2>
              <p className="text-sm text-gray-400 mt-1">Connecting you now...</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
