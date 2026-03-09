import { useEffect } from 'react';
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
import { disconnectSocket, connectSocket } from '@/lib/socket';

export default function LiveSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { phase, broadcasts, error: sessionError, connectionStatus, transitionStatus, setError, setPhase, reset } = useSessionStore();
  const { user } = useAuthStore();

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
  });

  const isHost = session?.hostUserId === user?.id || user?.role === 'admin';

  useSessionSocket(sessionId!);

  // If session is already completed (e.g. page refresh), show complete phase
  useEffect(() => {
    if (session?.status === 'completed') {
      setPhase('complete');
    }
  }, [session?.status, setPhase]);

  const handleLeave = () => {
    disconnectSocket();
    reset();
    navigate('/sessions');
  };

  if (!sessionId) return <PageLoader />;

  return (
    <div className="h-screen bg-surface-950 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-800 bg-surface-900/60">
        <h2 className="text-sm font-medium text-surface-300 truncate">{session?.title || 'Live Session'}</h2>
        <button
          onClick={handleLeave}
          className="flex items-center gap-1.5 text-sm text-surface-400 hover:text-red-400 transition-colors px-2 py-1 rounded-lg hover:bg-surface-800"
        >
          <LogOut className="h-4 w-4" /> Leave
        </button>
      </div>

      {/* Broadcast banner */}
      {broadcasts.length > 0 && (
        <div className="bg-brand-500/20 border-b border-brand-500/30 px-4 py-2 text-center">
          <p className="text-sm text-brand-300">{broadcasts[broadcasts.length - 1]}</p>
        </div>
      )}

      {/* Connection status banner */}
      {connectionStatus === 'connecting' && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-amber-400 animate-spin" />
          <p className="text-sm text-amber-300">Connecting to session...</p>
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
        <div className="bg-brand-500/10 border-b border-brand-500/20 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-brand-400 animate-spin" />
          <p className="text-sm text-brand-300">
            {transitionStatus === 'starting_session' && 'Session is starting — preparing your first match...'}
            {transitionStatus === 'preparing_match' && "You've been matched! Connecting to your partner..."}
            {transitionStatus === 'round_ending' && 'Round ending — wrapping up...'}
            {transitionStatus === 'between_rounds' && 'Getting ready for the next round...'}
            {transitionStatus === 'session_ending' && 'Session is wrapping up — preparing your recap...'}
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

      {phase === 'lobby' && <Lobby />}
      {phase === 'matched' && <VideoRoom />}
      {phase === 'rating' && <RatingPrompt sessionId={sessionId} />}
      {phase === 'complete' && <SessionComplete sessionId={sessionId} />}

      {/* Host controls visible in all active phases */}
      {isHost && phase !== 'complete' && <HostControls sessionId={sessionId} />}
    </div>
  );
}
