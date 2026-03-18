import { useEffect, useState } from 'react';
import { Shuffle } from 'lucide-react';

interface Props {
  roomCount: number;
  roundNumber: number;
}

export default function MatchingOverlay({ roomCount, roundNumber }: Props) {
  const [phase, setPhase] = useState<'matching' | 'result'>('matching');

  useEffect(() => {
    // After 1.8s, show the result
    const timer = setTimeout(() => setPhase('result'), 1800);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/95 backdrop-blur-sm">
      <div className="text-center space-y-6">
        {/* Animated icon */}
        <div className="relative mx-auto w-20 h-20">
          <div className="absolute inset-0 rounded-full bg-rsn-red/10 animate-ping" />
          <div className="relative flex items-center justify-center w-20 h-20 rounded-full bg-rsn-red/15">
            <Shuffle className="h-8 w-8 text-rsn-red animate-pulse" />
          </div>
        </div>

        {phase === 'matching' ? (
          <>
            <h2 className="text-xl font-semibold text-gray-800">Matching people...</h2>
            <p className="text-sm text-gray-500">Finding the best connections for Round {roundNumber}</p>
            {/* Animated dots */}
            <div className="flex items-center justify-center gap-1.5">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="w-2.5 h-2.5 rounded-full bg-rsn-red"
                  style={{
                    animation: 'pulse 1.2s ease-in-out infinite',
                    animationDelay: `${i * 0.3}s`,
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-gray-800">
              {roomCount} breakout room{roomCount !== 1 ? 's' : ''} created!
            </h2>
            <p className="text-sm text-gray-500">Connecting you now...</p>
          </>
        )}
      </div>
    </div>
  );
}
