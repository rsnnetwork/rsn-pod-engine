import { useState, useEffect, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import { Hand, Heart, ThumbsUp } from 'lucide-react';

const REACTIONS = [
  { type: 'raise_hand', icon: Hand, label: 'Raise Hand', emoji: '✋' },
  { type: 'heart', icon: Heart, label: 'Heart', emoji: '❤️' },
  { type: 'clap', icon: null, label: 'Clap', emoji: '👏' },
  { type: 'thumbs_up', icon: ThumbsUp, label: 'Thumbs Up', emoji: '👍' },
] as const;

interface FloatingReaction {
  id: string;
  emoji: string;
  displayName: string;
  x: number;
}

export default function ReactionBar({ sessionId }: { sessionId: string }) {
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const [cooldown, setCooldown] = useState(false);
  const hostInLobby = useSessionStore(s => s.hostInLobby);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const phase = useSessionStore(s => s.phase);
  const cohosts = useSessionStore(s => s.cohosts);
  const { user } = useAuthStore();
  const isHostOrCohost = user?.id === hostUserId || (!!user?.id && cohosts.has(user.id));
  const reactionsDisabled = phase === 'lobby' && !hostInLobby && !isHostOrCohost;

  // Listen for incoming reactions
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = (data: { userId: string; displayName: string; type: string; timestamp: string }) => {
      const reaction = REACTIONS.find(r => r.type === data.type);
      if (!reaction) return;

      const id = `${data.timestamp}-${data.userId}-${Math.random()}`;
      const x = 20 + Math.random() * 60; // random horizontal position 20-80%

      setFloatingReactions(prev => [...prev, { id, emoji: reaction.emoji, displayName: data.displayName, x }]);

      // Remove after animation
      setTimeout(() => {
        setFloatingReactions(prev => prev.filter(r => r.id !== id));
      }, 2500);
    };

    socket.on('reaction:received', handler);
    return () => { socket.off('reaction:received', handler); };
  }, []);

  const sendReaction = useCallback((type: string) => {
    if (cooldown) return;
    const socket = getSocket();
    if (!socket) return;

    socket.emit('reaction:send', { sessionId, type });
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1000);
  }, [sessionId, cooldown]);

  return (
    <>
      {/* Floating reaction animations */}
      <div className="fixed bottom-24 left-0 right-0 pointer-events-none z-30">
        {floatingReactions.map(r => (
          <div
            key={r.id}
            className="absolute animate-float-up text-center"
            style={{ left: `${r.x}%` }}
          >
            <span className="text-3xl">{r.emoji}</span>
            <span className="block text-[10px] text-gray-300 font-medium mt-0.5">{r.displayName}</span>
          </div>
        ))}
      </div>

      {/* Reaction buttons — hidden when host is not in lobby */}
      {!reactionsDisabled && (
        <div className="flex items-center gap-1 bg-[#3c4043]/90 backdrop-blur-sm rounded-full px-2 py-1">
          {REACTIONS.map(({ type, emoji, label }) => (
            <button
              key={type}
              onClick={() => sendReaction(type)}
              disabled={cooldown}
              title={label}
              className="p-1.5 rounded-full hover:bg-white/10 active:scale-90 transition-all disabled:opacity-40 text-lg leading-none"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
