import { useSessionStore } from '@/stores/sessionStore';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { formatTime } from '@/lib/utils';
import { Video, Clock, Mic, Wifi } from 'lucide-react';

function AudioBars({ active }: { active: boolean }) {
  return (
    <div className="flex items-end gap-0.5 h-4">
      {[1, 2, 3, 4, 5].map(i => (
        <div
          key={i}
          className={`w-1 rounded-full transition-all ${active ? 'bg-emerald-400' : 'bg-surface-700'}`}
          style={active ? {
            animation: `audioBar 0.8s ease-in-out ${i * 0.1}s infinite alternate`,
            height: `${30 + Math.random() * 70}%`,
          } : { height: '20%' }}
        />
      ))}
      {active && (
        <style>{`@keyframes audioBar { 0% { height: 20%; } 100% { height: ${60 + Math.random() * 40}%; } }`}</style>
      )}
    </div>
  );
}

function ConnectionIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
      <Wifi className="h-3 w-3 text-emerald-400" />
      <span className="text-xs text-emerald-400">Connected</span>
    </div>
  );
}

export default function VideoRoom() {
  const { currentMatch, timerSeconds, currentRound, isByeRound } = useSessionStore();

  if (isByeRound) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center">
          <div className="h-20 w-20 rounded-full bg-surface-800 flex items-center justify-center mx-auto mb-4">
            <Video className="h-8 w-8 text-surface-500" />
          </div>
          <h3 className="text-lg font-semibold text-surface-200 mb-2">Bye Round</h3>
          <p className="text-surface-400 text-sm">
            You have a bye this round. Sit tight — you'll be matched next round!
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-4 gap-4">
      {/* Timer bar */}
      <div className="flex items-center justify-between bg-surface-900/60 rounded-xl px-4 py-3 border border-surface-800">
        <div className="flex items-center gap-3">
          <span className="text-sm text-surface-400">Round {currentRound}</span>
          <ConnectionIndicator />
        </div>
        <div className="flex items-center gap-2 text-surface-200">
          <Clock className="h-4 w-4" />
          <span className={`font-mono text-lg ${timerSeconds <= 30 ? 'text-amber-400' : ''} ${timerSeconds <= 10 ? 'text-red-400 animate-pulse' : ''}`}>
            {formatTime(timerSeconds)}
          </span>
        </div>
      </div>

      {/* Video area */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Your video */}
        <Card className="relative flex flex-col items-center justify-center min-h-[300px] overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-surface-800/30 to-surface-900/60" />
          <div className="relative z-10 flex flex-col items-center">
            <div className="relative">
              <div className="h-32 w-32 rounded-full bg-gradient-to-br from-brand-500/20 to-brand-600/10 border-2 border-brand-500/30 flex items-center justify-center mb-4">
                <Video className="h-12 w-12 text-brand-400" />
              </div>
              <div className="absolute -bottom-1 -right-1 bg-surface-900 rounded-full p-1">
                <Mic className="h-4 w-4 text-emerald-400" />
              </div>
            </div>
            <p className="text-surface-200 font-medium">You</p>
            <div className="mt-2 flex items-center gap-2">
              <AudioBars active />
              <span className="text-xs text-surface-500">Live</span>
            </div>
          </div>
        </Card>

        {/* Partner video */}
        <Card className="relative flex flex-col items-center justify-center min-h-[300px] overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-surface-800/30 to-surface-900/60" />
          {currentMatch ? (
            <div className="relative z-10 flex flex-col items-center">
              <div className="relative">
                <div className="ring-2 ring-emerald-500/30 rounded-full mb-4">
                  <Avatar name={currentMatch.displayName || 'Partner'} size="xl" />
                </div>
                <div className="absolute -bottom-1 -right-1 bg-surface-900 rounded-full p-1">
                  <Mic className="h-4 w-4 text-emerald-400" />
                </div>
              </div>
              <p className="text-surface-200 font-medium">{currentMatch.displayName || 'Your Match'}</p>
              <div className="mt-2 flex items-center gap-2">
                <AudioBars active />
                <span className="text-xs text-surface-500">Connected</span>
              </div>
            </div>
          ) : (
            <div className="relative z-10 flex flex-col items-center">
              <div className="h-32 w-32 rounded-full bg-surface-800 flex items-center justify-center mb-4 animate-pulse border-2 border-surface-700">
                <Video className="h-12 w-12 text-surface-600" />
              </div>
              <p className="text-surface-500">Waiting for match...</p>
              <AudioBars active={false} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
