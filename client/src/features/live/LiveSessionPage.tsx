import { useParams } from 'react-router-dom';
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
import { AlertCircle, X } from 'lucide-react';
import api from '@/lib/api';

export default function LiveSessionPage() {
  const { sessionId } = useParams();
  const { phase, broadcasts, error: sessionError, setError } = useSessionStore();
  const { user } = useAuthStore();

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
  });

  const isHost = session?.hostUserId === user?.id || user?.role === 'admin';

  useSessionSocket(sessionId!);

  if (!sessionId) return <PageLoader />;

  return (
    <div className="h-screen bg-surface-950 flex flex-col">
      {/* Broadcast banner */}
      {broadcasts.length > 0 && (
        <div className="bg-brand-500/20 border-b border-brand-500/30 px-4 py-2 text-center">
          <p className="text-sm text-brand-300">{broadcasts[broadcasts.length - 1]}</p>
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
