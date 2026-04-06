import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import useSessionSocket from '@/hooks/useSessionSocket';
import Lobby from './Lobby';
import VideoRoom from './VideoRoom';
import RatingPrompt from './RatingPrompt';
import SessionComplete from './SessionComplete';
import HostControls from './HostControls';
import ChatPanel from './ChatPanel';
// MatchingOverlay replaced with inline banner — no longer full-screen
import ReactionBar from './ReactionBar';
import ParticipantList from './ParticipantList';
import { SectionErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoader } from '@/components/ui/Spinner';
import { AlertCircle, X, LogOut, WifiOff, Loader2, RefreshCw, MessageCircle, Radio, Users, Shuffle, Mic, ArrowLeftRight, CheckCircle2 } from 'lucide-react';
import api from '@/lib/api';
import { disconnectSocket, connectSocket, getSocket } from '@/lib/socket';

export default function LiveSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const phase = useSessionStore(s => s.phase);
  const broadcasts = useSessionStore(s => s.broadcasts);
  const sessionError = useSessionStore(s => s.error);
  const connectionStatus = useSessionStore(s => s.connectionStatus);
  const transitionStatus = useSessionStore(s => s.transitionStatus);
  const sessionStatus = useSessionStore(s => s.sessionStatus);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const chatOpen = useSessionStore(s => s.chatOpen);
  const unreadChatCount = useSessionStore(s => s.unreadChatCount);
  const matchingOverlay = useSessionStore(s => s.matchingOverlay);
  const preparingMatches = useSessionStore(s => s.preparingMatches);
  const { setError, setPhase, reset, setChatOpen } = useSessionStore.getState();
  const { user } = useAuthStore();
  const mediaRequestedRef = useRef(false);
  const [participantListOpen, setParticipantListOpen] = useState(false);

  const [mediaError, setMediaError] = useState(false);

  // Request media permissions once per event entry (not per room transition)
  useEffect(() => {
    if (mediaRequestedRef.current) return;
    mediaRequestedRef.current = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError(true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop());
      })
      .catch(() => {
        setMediaError(true);
      });
  }, []);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
  });

  const cohosts = useSessionStore(s => s.cohosts);
  const isOriginalHost = session?.hostUserId === user?.id;
  const isCohost = !!user?.id && cohosts.has(user.id);
  const isHost = isOriginalHost || isCohost;

  useSessionSocket(sessionId!);

  // If session is already completed (e.g. page refresh), show complete phase
  useEffect(() => {
    if (session?.status === 'completed') {
      setPhase('complete');
    }
  }, [session?.status, setPhase]);

  const handleLeave = () => {
    const inActivePhase = phase === 'matched' || phase === 'rating';
    const message = inActivePhase
      ? 'You are in an active round. Leaving now will end your current conversation and you may miss this round. Are you sure?'
      : 'Are you sure you want to leave this event?';
    if (!confirm(message)) return;
    getSocket()?.emit('session:leave', { sessionId: sessionId! });
    disconnectSocket();
    reset();
    navigate('/sessions');
  };

  if (!sessionId) return <PageLoader />;

  return (
    <div className="h-screen bg-white flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200">
        <h2 className="text-sm font-medium text-[#1a1a2e] truncate">{session?.title || 'Live Event'}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setParticipantListOpen(!participantListOpen)}
            className={`p-2 rounded-full transition-colors ${participantListOpen ? 'bg-gray-200 text-[#1a1a2e]' : 'text-gray-500 hover:text-[#1a1a2e] hover:bg-gray-100'}`}
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            onClick={handleLeave}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-500 transition-colors px-3 py-1.5 rounded-full hover:bg-gray-100"
          >
            <LogOut className="h-4 w-4" /> Leave
          </button>
        </div>
      </div>

      {/* Persistent event state banner */}
      {connectionStatus === 'connected' && (
        <EventStateBanner sessionStatus={sessionStatus} currentRound={currentRound} totalRounds={totalRounds} phase={phase} />
      )}

      {/* Broadcast banner */}
      {broadcasts.length > 0 && (
        <div className="bg-rsn-red px-4 py-2 text-center">
          <p className="text-sm font-medium text-white"><LinkifyText text={broadcasts[broadcasts.length - 1]} /></p>
        </div>
      )}

      {/* Connection status banner */}
      {connectionStatus === 'connecting' && (
        <div className="bg-gray-100 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
          <p className="text-sm text-gray-400">Connecting to event...</p>
        </div>
      )}
      {connectionStatus === 'reconnecting' && (
        <div className="bg-amber-500/10 px-4 py-2 flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-400">Connection lost — reconnecting...</p>
        </div>
      )}
      {connectionStatus === 'disconnected' && (
        <div className="bg-red-500/10 px-4 py-2 flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4 text-red-400" />
          <p className="text-sm text-red-400">Disconnected from server.</p>
          <button
            onClick={() => connectSocket()}
            className="ml-2 flex items-center gap-1 text-sm text-red-400 hover:text-red-300 underline"
          >
            <RefreshCw className="h-3 w-3" /> Reconnect
          </button>
        </div>
      )}

      {/* Transition status overlay */}
      {transitionStatus && (
        <div className="bg-gray-100 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
          <p className="text-sm text-gray-300">
            {transitionStatus === 'starting_session' && (isHost ? 'Starting event — lobby is open' : 'Event is starting — waiting for host to begin matching...')}
            {transitionStatus === 'preparing_match' && (isHost ? 'Sending participants to breakout rooms...' : "You've been matched! Connecting to your partner...")}
            {transitionStatus === 'round_ending' && (isHost ? 'Ending round — collecting participants...' : 'Round ending — wrapping up...')}
            {transitionStatus === 'between_rounds' && (isHost ? 'Preparing next round...' : 'Getting ready for the next round...')}
            {transitionStatus === 'session_ending' && (isHost ? 'Ending event — generating recaps...' : 'Event is wrapping up — preparing your recap...')}
          </p>
        </div>
      )}

      {/* Error banner — dismissable */}
      {mediaError && (
        <div className="bg-amber-500/15 px-4 py-2 flex items-center justify-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-300">Camera/microphone access denied. Check browser permissions to enable video.</p>
          <button onClick={() => setMediaError(false)} className="ml-2 text-amber-400 hover:text-amber-300">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {sessionError && (
        <div className="bg-red-500/15 px-4 py-2 flex items-center justify-center gap-2">
          <AlertCircle className="h-4 w-4 text-red-400" />
          <p className="text-sm text-red-400">{sessionError}</p>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-300">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* "Host is preparing matches" — light top banner, not full-screen overlay */}
      {preparingMatches && !matchingOverlay && !isHost && (
        <div className="bg-blue-500/10 px-4 py-2.5 flex items-center justify-center gap-2">
          <Shuffle className="h-4 w-4 text-blue-400 animate-pulse" />
          <p className="text-sm text-blue-300 font-medium">Host is preparing matches...</p>
          <div className="flex items-center gap-1 ml-1">
            {[0, 1, 2].map(i => (
              <div key={i} className="w-1.5 h-1.5 rounded-full bg-blue-400/70" style={{ animation: 'bounce 1s ease-in-out infinite', animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        </div>
      )}

      {/* Matching anticipation — light banner instead of full-screen overlay */}
      {matchingOverlay && !isHost && (
        <div className="bg-emerald-500/10 px-4 py-2.5 flex items-center justify-center gap-2">
          <Shuffle className="h-4 w-4 text-emerald-400" />
          <p className="text-sm text-emerald-300 font-medium">You've been matched! Connecting to Room {matchingOverlay.roomCount}...</p>
        </div>
      )}

      {/* Main content + chat panel layout */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Session content */}
        <div className={`flex-1 flex flex-col overflow-hidden ${chatOpen ? 'hidden sm:flex' : ''}`}>
          {phase === 'lobby' && <SectionErrorBoundary name="Lobby"><Lobby isHost={isHost} sessionId={sessionId} /></SectionErrorBoundary>}
          {phase === 'matched' && <SectionErrorBoundary name="Video"><VideoRoom isHost={isHost} /></SectionErrorBoundary>}
          {phase === 'rating' && <SectionErrorBoundary name="Rating"><RatingPrompt sessionId={sessionId} /></SectionErrorBoundary>}
          {phase === 'complete' && <SessionComplete sessionId={sessionId} />}
        </div>

        {/* Participant list panel */}
        {participantListOpen && !chatOpen && (
          <div className="w-full sm:w-72 sm:min-w-[288px] flex-shrink-0 h-full border-l border-white/10">
            <ParticipantList onClose={() => setParticipantListOpen(false)} sessionId={sessionId} />
          </div>
        )}

        {/* Chat panel -- side panel on desktop, full overlay on mobile */}
        {chatOpen && (
          <div className="w-full sm:w-80 sm:min-w-[320px] flex-shrink-0 h-full">
            <SectionErrorBoundary name="Chat"><ChatPanel sessionId={sessionId} onClose={() => setChatOpen(false)} /></SectionErrorBoundary>
          </div>
        )}

        {/* Reaction bar — toggleable, bottom-left */}
        {phase !== 'complete' && phase !== 'rating' && sessionId && (
          <ReactionBar sessionId={sessionId} />
        )}

        {/* Chat toggle button */}
        {!chatOpen && phase !== 'complete' && (
          <button
            onClick={() => setChatOpen(true)}
            className="absolute bottom-20 right-4 z-20 p-3 bg-[#3c4043] text-white rounded-full shadow-lg hover:bg-[#4a4e51] transition-all"
          >
            <MessageCircle className="h-5 w-5" />
            {unreadChatCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[20px] h-5 flex items-center justify-center bg-blue-500 text-white text-[11px] font-bold rounded-full px-1">
                {unreadChatCount > 9 ? '9+' : unreadChatCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Host controls visible in all active phases */}
      {isHost && phase !== 'complete' && <HostControls sessionId={sessionId} />}
    </div>
  );
}

/* ─── Persistent Event State Banner ─────────────────────────────────────── */

const STATE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  scheduled:        { label: 'Event not started yet', icon: <Users className="h-3.5 w-3.5" />, color: 'bg-white/5 text-gray-400' },
  lobby_open:       { label: 'Main Room — waiting for host to start round', icon: <Mic className="h-3.5 w-3.5" />, color: 'bg-white/5 text-gray-300' },
  round_active:     { label: 'Round {round} Live', icon: <Radio className="h-3.5 w-3.5 animate-pulse" />, color: 'bg-red-500/10 text-red-400' },
  round_rating:     { label: 'Rating — Round {round}', icon: <ArrowLeftRight className="h-3.5 w-3.5" />, color: 'bg-amber-500/10 text-amber-400' },
  round_transition: { label: 'Back in main room', icon: <Shuffle className="h-3.5 w-3.5" />, color: 'bg-white/5 text-gray-300' },
  closing_lobby:    { label: 'Event wrapping up', icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, color: 'bg-white/5 text-gray-400' },
  completed:        { label: 'Event completed', icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: 'bg-emerald-500/10 text-emerald-400' },
};

function EventStateBanner({ sessionStatus, currentRound, totalRounds }: { sessionStatus: string; currentRound: number; totalRounds: number; phase?: string }) {
  const config = STATE_CONFIG[sessionStatus] || STATE_CONFIG.scheduled;
  const label = config.label
    .replace('{round}', String(currentRound || 1));
  const roundInfo = totalRounds > 0 && sessionStatus !== 'completed' && sessionStatus !== 'scheduled'
    ? ` · Round ${currentRound || 1} of ${totalRounds}`
    : '';

  // Don't duplicate round info if already in label
  const showRoundInfo = roundInfo && !label.includes(`Round ${currentRound || 1}`);

  return (
    <div className={`px-4 py-1.5 flex items-center justify-center gap-2 text-xs font-medium ${config.color}`}>
      {config.icon}
      <span>{label}{showRoundInfo ? roundInfo : ''}</span>
    </div>
  );
}

/* ─── Linkify helper for broadcast banner ───────────────────────────────── */

const LINK_REGEX = /(https?:\/\/[^\s<]+)/g;

function LinkifyText({ text }: { text: string }) {
  const parts = text.split(LINK_REGEX);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80 break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
