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
  { type: 'fire', icon: null, label: 'Fire', emoji: '🔥' },
  { type: 'laugh', icon: null, label: 'Laugh', emoji: '😂' },
  { type: 'surprise', icon: null, label: 'Wow', emoji: '😮' },
  { type: 'wave', icon: null, label: 'Wave', emoji: '👋' },
  { type: 'party', icon: null, label: 'Party', emoji: '🎉' },
  { type: 'hundred', icon: null, label: '100', emoji: '💯' },
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

      // Bug 10 (April 19) — Meet/Zoom-style: anchor reaction to the
      // sender's tile (via store), persist 8 seconds. Replaces the
      // floating-emoji-only UX so people can SEE who reacted.
      useSessionStore.getState().setTileReaction(data.userId, reaction.emoji, data.displayName);
      setTimeout(() => {
        useSessionStore.getState().clearTileReaction(data.userId);
      }, 8000);

      // Keep the floating animation as a brief secondary cue (1.5s).
      const id = `${data.timestamp}-${data.userId}-${Math.random()}`;
      const x = 20 + Math.random() * 60;
      setFloatingReactions(prev => [...prev, { id, emoji: reaction.emoji, displayName: data.displayName, x }]);
      setTimeout(() => {
        setFloatingReactions(prev => prev.filter(r => r.id !== id));
      }, 1500);
    };

    socket.on('reaction:received', handler);
    return () => { socket.off('reaction:received', handler); };
  }, []);

  const sendReaction = useCallback((type: string) => {
    if (cooldown) return;
    const socket = getSocket();
    if (!socket) return;

    const matchId = useSessionStore.getState().currentMatchId;
    socket.emit('reaction:send', { sessionId, type, matchId: matchId || undefined });
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1000);
  }, [sessionId, cooldown]);

  const [showPanel, setShowPanel] = useState(false);

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
            <span className="block text-[10px] text-[#1a1a2e] font-medium mt-0.5">{r.displayName}</span>
          </div>
        ))}
      </div>

      {/* Reaction toggle button + popup panel */}
      {!reactionsDisabled && (
        <div className="fixed bottom-20 left-4 z-20">
          {showPanel && (
            <div className="absolute bottom-12 left-0 flex items-center gap-1 bg-white shadow-xl border border-gray-200 rounded-2xl px-2 py-1.5 mb-2">
              {REACTIONS.map(({ type, emoji, label }) => (
                <button
                  key={type}
                  onClick={() => { sendReaction(type); setShowPanel(false); }}
                  disabled={cooldown}
                  title={label}
                  className="p-1.5 rounded-full hover:bg-gray-100 active:scale-90 transition-all disabled:opacity-40 text-lg leading-none"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setShowPanel(!showPanel)}
            className="p-3 bg-white shadow-lg border border-gray-200 rounded-full hover:bg-gray-50 transition-colors text-lg"
            title="Reactions"
          >
            😀
          </button>
        </div>
      )}
    </>
  );
}
