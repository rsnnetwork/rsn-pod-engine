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
import MatchingOverlay from './MatchingOverlay';
import ReactionBar from './ReactionBar';
import ParticipantList from './ParticipantList';
import { PageLoader } from '@/components/ui/Spinner';
import { AlertCircle, X, LogOut, WifiOff, Loader2, RefreshCw, MessageCircle, Radio, Users, Shuffle, Mic, ArrowLeftRight, CheckCircle2 } from 'lucide-react';
import api from '@/lib/api';
import { disconnectSocket, connectSocket, getSocket } from '@/lib/socket';

export default function LiveSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { phase, broadcasts, error: sessionError, connectionStatus, transitionStatus, sessionStatus, currentRound, totalRounds, setError, setPhase, reset, chatOpen, setChatOpen, unreadChatCount, matchingOverlay } = useSessionStore();
  const { user } = useAuthStore();
  const mediaRequestedRef = useRef(false);
  const [participantListOpen, setParticipantListOpen] = useState(false);

  // Request media permissions once per event entry (not per room transition)
  useEffect(() => {
    if (mediaRequestedRef.current) return;
    mediaRequestedRef.current = true;
    navigator.mediaDevices?.getUserMedia({ video: true, audio: true })
      .then(stream => {
        // Stop tracks immediately — we just needed the permission grant
        stream.getTracks().forEach(t => t.stop());
      })
      .catch(() => {
        // User denied or no device — LiveKit will handle gracefully
      });
  }, []);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
  });

  const isHost = session?.hostUserId === user?.id;

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
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50/60">
        <h2 className="text-sm font-medium text-gray-600 truncate">{session?.title || 'Live Event'}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setParticipantListOpen(!participantListOpen)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors px-2 py-1 rounded-lg hover:bg-gray-100"
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            onClick={handleLeave}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-gray-100"
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
        <div className="bg-rsn-red-light border-b border-rsn-red/30 px-4 py-2 text-center">
          <p className="text-sm font-medium text-rsn-red"><LinkifyText text={broadcasts[broadcasts.length - 1]} /></p>
        </div>
      )}

      {/* Connection status banner */}
      {connectionStatus === 'connecting' && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-amber-400 animate-spin" />
          <p className="text-sm text-amber-300">Connecting to event...</p>
        </div>
      )}
      {connectionStatus === 'reconnecting' && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-300">Connection lost — reconnecting...</p>
        </div>
      )}
      {connectionStatus === 'disconnected' && (
        <div className="bg-red-500/20 border-b border-red-500/30 px-4 py-2 flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4 text-red-400" />
          <p className="text-sm text-red-300">Disconnected from server.</p>
          <button
            onClick={() => connectSocket()}
            className="ml-2 flex items-center gap-1 text-sm text-red-300 hover:text-red-100 underline"
          >
            <RefreshCw className="h-3 w-3" /> Reconnect
          </button>
        </div>
      )}

      {/* Transition status overlay — host sees host-specific messages */}
      {transitionStatus && (
        <div className="bg-[#1a1a2e]/10 border-b border-brand-500/20 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-rsn-red animate-spin" />
          <p className="text-sm text-rsn-red">
            {transitionStatus === 'starting_session' && (isHost ? 'Starting event — generating matches...' : 'Event is starting — preparing your first match...')}
            {transitionStatus === 'preparing_match' && (isHost ? 'Sending participants to breakout rooms...' : "You've been matched! Connecting to your partner...")}
            {transitionStatus === 'round_ending' && (isHost ? 'Ending round — collecting participants...' : 'Round ending — wrapping up...')}
            {transitionStatus === 'between_rounds' && (isHost ? 'Preparing next round...' : 'Getting ready for the next round...')}
            {transitionStatus === 'session_ending' && (isHost ? 'Ending event — generating recaps...' : 'Event is wrapping up — preparing your recap...')}
          </p>
        </div>
      )}

      {/* Error banner — dismissable */}
      {sessionError && (
        <div className="bg-red-500/20 border-b border-red-500/30 px-4 py-2 flex items-center justify-center gap-2">
          <AlertCircle className="h-4 w-4 text-red-400" />
          <p className="text-sm text-red-300">{sessionError}</p>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-200">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Matching anticipation overlay */}
      {matchingOverlay && (
        <MatchingOverlay roomCount={matchingOverlay.roomCount} roundNumber={matchingOverlay.roundNumber} />
      )}

      {/* Main content + chat panel layout */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Session content */}
        <div className={`flex-1 flex flex-col overflow-hidden ${chatOpen ? 'hidden sm:flex' : ''}`}>
          {phase === 'lobby' && <Lobby isHost={isHost} sessionId={sessionId} />}
          {phase === 'matched' && <VideoRoom isHost={isHost} />}
          {phase === 'rating' && <RatingPrompt sessionId={sessionId} />}
          {phase === 'complete' && <SessionComplete sessionId={sessionId} />}
        </div>

        {/* Participant list panel */}
        {participantListOpen && !chatOpen && (
          <div className="w-full sm:w-72 sm:min-w-[288px] flex-shrink-0 h-full">
            <ParticipantList onClose={() => setParticipantListOpen(false)} />
          </div>
        )}

        {/* Chat panel -- side panel on desktop, full overlay on mobile */}
        {chatOpen && (
          <div className="w-full sm:w-80 sm:min-w-[320px] flex-shrink-0 h-full">
            <ChatPanel sessionId={sessionId} onClose={() => setChatOpen(false)} />
          </div>
        )}

        {/* Reaction bar — visible during lobby and matched phases */}
        {phase !== 'complete' && phase !== 'rating' && sessionId && (
          <div className="absolute bottom-20 left-4 z-20">
            <ReactionBar sessionId={sessionId} />
          </div>
        )}

        {/* Chat toggle button -- positioned above host controls bar */}
        {!chatOpen && phase !== 'complete' && (
          <button
            onClick={() => setChatOpen(true)}
            className="absolute bottom-20 right-4 z-20 p-3 bg-rsn-red text-white rounded-full shadow-lg hover:bg-rsn-red/90 transition-all hover:scale-105"
          >
            <MessageCircle className="h-5 w-5" />
            {unreadChatCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[20px] h-5 flex items-center justify-center bg-amber-500 text-white text-[11px] font-bold rounded-full px-1">
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
  scheduled:        { label: 'Waiting for participants', icon: <Users className="h-3.5 w-3.5" />, color: 'bg-blue-50 text-blue-700 border-blue-200' },
  lobby_open:       { label: 'Lobby — waiting for host to start round', icon: <Mic className="h-3.5 w-3.5" />, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  round_active:     { label: 'Round {round} Live', icon: <Radio className="h-3.5 w-3.5 animate-pulse" />, color: 'bg-rsn-red/10 text-rsn-red border-rsn-red/20' },
  round_rating:     { label: 'Rating — Round {round}', icon: <ArrowLeftRight className="h-3.5 w-3.5" />, color: 'bg-amber-50 text-amber-700 border-amber-200' },
  round_transition: { label: 'Back in lobby', icon: <Shuffle className="h-3.5 w-3.5" />, color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  closing_lobby:    { label: 'Event wrapping up', icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, color: 'bg-gray-100 text-gray-600 border-gray-200' },
  completed:        { label: 'Event completed', icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
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
    <div className={`px-4 py-1.5 border-b flex items-center justify-center gap-2 text-xs font-medium ${config.color}`}>
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
        LINK_REGEX.test(part) ? (
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
