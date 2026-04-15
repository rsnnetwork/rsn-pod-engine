import { useEffect, useState } from 'react';
import { Users, Sparkles } from 'lucide-react';

interface Props {
  roomCount: number;
  roundNumber: number;
}

export default function MatchingOverlay({ roomCount }: Props) {
  const [visible, setVisible] = useState(false);

  // Fade in on mount
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-[#202124]/90 backdrop-blur-sm transition-opacity duration-500 ${visible ? 'opacity-100' : 'opacity-0'}`}>
      <div className="text-center space-y-6 px-6 animate-fade-in">

        {/* Animated icon */}
        <div className="relative mx-auto w-28 h-28">
          {/* Outer pulse rings */}
          <div className="absolute inset-0 rounded-full border-2 border-emerald-400/30 animate-ping" />
          <div className="absolute inset-3 rounded-full border border-emerald-400/20 animate-ping" style={{ animationDelay: '0.4s' }} />
          <div className="absolute inset-6 rounded-full border border-emerald-400/10 animate-ping" style={{ animationDelay: '0.8s' }} />

          {/* Center icon */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center">
              <Users className="h-8 w-8 text-emerald-400" />
            </div>
          </div>

          {/* Orbiting sparkles */}
          {[0, 1, 2, 3].map(i => (
            <div
              key={i}
              className="absolute"
              style={{
                top: `${50 + 40 * Math.sin((i * Math.PI * 2) / 4)}%`,
                left: `${50 + 40 * Math.cos((i * Math.PI * 2) / 4)}%`,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <Sparkles className="h-4 w-4 text-emerald-400/60" style={{
                animation: 'pulse 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.3}s`,
              }} />
            </div>
          ))}
        </div>

        {/* Text */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-white">You've been matched!</h2>
          <p className="text-gray-400 text-sm">
            {roomCount > 0 ? `${roomCount} breakout room${roomCount !== 1 ? 's' : ''} ready` : 'Get ready for your conversation'}
          </p>
        </div>

        {/* Animated dots */}
        <div className="flex items-center justify-center gap-1.5">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="w-2 h-2 rounded-full bg-emerald-400"
              style={{
                animation: 'bounce 1s ease-in-out infinite',
                animationDelay: `${i * 0.15}s`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
