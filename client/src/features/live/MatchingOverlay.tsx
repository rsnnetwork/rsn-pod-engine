import { useEffect, useState } from 'react';
import { Shuffle, CheckCircle2 } from 'lucide-react';

interface Props {
  roomCount: number;
  roundNumber: number;
}

export default function MatchingOverlay({ roundNumber }: Props) {
  const [phase, setPhase] = useState<'matching' | 'result'>('matching');
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    const timer = setTimeout(() => setPhase('result'), 1000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (phase !== 'result') return;
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#202124]/95 backdrop-blur-sm">
      <div className="text-center space-y-6 px-6">

        {phase === 'matching' ? (
          <>
            {/* Animated connecting nodes */}
            <div className="relative mx-auto w-32 h-32">
              {/* Outer ring pulse */}
              <div className="absolute inset-0 rounded-full border-2 border-blue-500/20 animate-ping" />
              <div className="absolute inset-2 rounded-full border border-blue-500/10 animate-ping" style={{ animationDelay: '0.5s' }} />

              {/* Center icon */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-blue-500/10 flex items-center justify-center">
                  <Shuffle className="h-7 w-7 text-blue-400" />
                </div>
              </div>

              {/* Orbiting dots */}
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div
                  key={i}
                  className="absolute w-3 h-3 rounded-full bg-blue-400/60"
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
              <h2 className="text-xl font-semibold text-white">Matching people now</h2>
              <p className="text-sm text-gray-400 mt-1">Pairing you up for Round {roundNumber}</p>
            </div>

            {/* Animated progress dots */}
            <div className="flex items-center justify-center gap-2">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-blue-400/70"
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
              <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping opacity-40" />
              <div className="relative flex items-center justify-center w-20 h-20 rounded-full bg-emerald-500/10">
                <CheckCircle2 className="h-10 w-10 text-emerald-400" />
              </div>
            </div>

            <div>
              <h2 className="text-xl font-semibold text-white">
                You've been matched!
              </h2>
              <p className="text-sm text-gray-400 mt-1">
                {countdown > 0 ? `Entering breakout room in ${countdown}...` : 'Connecting you to your breakout room...'}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
