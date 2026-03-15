import { useEffect, useRef } from 'react';
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
import { PageLoader } from '@/components/ui/Spinner';
import { AlertCircle, X, LogOut, WifiOff, Loader2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { disconnectSocket, connectSocket, getSocket } from '@/lib/socket';

export default function LiveSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { phase, broadcasts, error: sessionError, connectionStatus, transitionStatus, setError, setPhase, reset } = useSessionStore();
  const { user } = useAuthStore();
  const mediaRequestedRef = useRef(false);

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
    getSocket()?.emit('session:leave', { sessionId });
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
        <button
          onClick={handleLeave}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-gray-100"
        >
          <LogOut className="h-4 w-4" /> Leave
        </button>
      </div>

      {/* Broadcast banner */}
      {broadcasts.length > 0 && (
        <div className="bg-indigo-50 border-b border-brand-500/30 px-4 py-2 text-center">
          <p className="text-sm text-brand-300">{broadcasts[broadcasts.length - 1]}</p>
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

      {/* Transition status overlay */}
      {transitionStatus && (
        <div className="bg-[#1a1a2e]/10 border-b border-brand-500/20 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-indigo-600 animate-spin" />
          <p className="text-sm text-brand-300">
            {transitionStatus === 'starting_session' && 'Event is starting — preparing your first match...'}
            {transitionStatus === 'preparing_match' && "You've been matched! Connecting to your partner..."}
            {transitionStatus === 'round_ending' && 'Round ending — wrapping up...'}
            {transitionStatus === 'between_rounds' && 'Getting ready for the next round...'}
            {transitionStatus === 'session_ending' && 'Event is wrapping up — preparing your recap...'}
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

      {phase === 'lobby' && <Lobby isHost={isHost} sessionId={sessionId} />}
      {phase === 'matched' && <VideoRoom isHost={isHost} />}
      {phase === 'rating' && <RatingPrompt sessionId={sessionId} />}
      {phase === 'complete' && <SessionComplete sessionId={sessionId} />}

      {/* Host controls visible in all active phases */}
      {isHost && phase !== 'complete' && <HostControls sessionId={sessionId} />}
    </div>
  );
}
