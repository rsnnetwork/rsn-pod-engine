import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Pause, StopCircle, Users, Settings, Radio, Send, MessageSquare } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

export default function HostDashboardPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    refetchInterval: 5000,
  });

  const { data: participants } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then(r => r.data.data ?? []),
    enabled: !!sessionId,
    refetchInterval: 5000,
  });

  const { data: liveState } = useQuery({
    queryKey: ['host-state', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/host/state`).then(r => r.data.data),
    enabled: !!sessionId,
    refetchInterval: 3000,
  });

  const hostAction = async (action: string, body?: any) => {
    setLoading(action);
    try {
      await api.post(`/sessions/${sessionId}/host/${action}`, body);
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['host-state', sessionId] });
      addToast(`Session ${action} successful`, 'success');
    } catch (err: any) {
      addToast(err?.response?.data?.message || `Failed to ${action}`, 'error');
    } finally {
      setLoading(null);
    }
  };

  const sendBroadcast = async () => {
    if (!broadcastMsg.trim()) return;
    await hostAction('broadcast', { message: broadcastMsg.trim() });
    setBroadcastMsg('');
  };

  if (isLoading) return <PageLoader />;
  if (!session) return <p className="text-surface-400 text-center py-20">Session not found</p>;

  // Auth check: Only host or admin can access
  const isHost = session.hostUserId === user?.id || user?.role === 'admin';
  if (!isHost) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-950 p-4">
        <Card className="max-w-md text-center">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-red-500/20 text-red-400 mx-auto mb-4">
            <Settings className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold text-surface-100 mb-2">Access Denied</h2>
          <p className="text-surface-400 mb-4">Only the session host can access this dashboard.</p>
          <Button variant="secondary" onClick={() => navigate(`/sessions/${sessionId}`)}>Back to Session</Button>
        </Card>
      </div>
    );
  }

  const statusVariant = session.status === 'scheduled' ? 'info'
    : session.status === 'lobby_open' || session.status === 'round_active' ? 'success'
    : session.status === 'completed' ? 'default' : 'warning';

  const isActive = ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'].includes(session.status);

  return (
    <div className="max-w-4xl mx-auto space-y-6 p-4 md:p-8">
      <button onClick={() => navigate('/sessions')} className="flex items-center gap-2 text-surface-400 hover:text-surface-200 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Sessions
      </button>

      <div className="flex items-center justify-between animate-fade-in">
        <h1 className="text-2xl font-bold text-surface-100">Host Dashboard</h1>
        <Badge variant={statusVariant}>{session.status?.replace(/_/g, ' ')}</Badge>
      </div>

      {/* Session Info */}
      <Card className="animate-fade-in-up">
        <h2 className="font-semibold text-surface-200 mb-3 flex items-center gap-2">
          <Settings className="h-5 w-5 text-brand-400" /> Session Info
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div><span className="text-surface-500">Title:</span> <span className="text-surface-200 ml-1">{session.title || 'Open'}</span></div>
          <div><span className="text-surface-500">Scheduled:</span> <span className="text-surface-200 ml-1">{new Date(session.scheduledAt).toLocaleString()}</span></div>
          <div><span className="text-surface-500">Participants:</span> <span className="text-surface-200 ml-1">{(participants || []).length}</span></div>
          <div><span className="text-surface-500">Rounds:</span> <span className="text-surface-200 ml-1">{session.config?.numberOfRounds || 5}</span></div>
          <div><span className="text-surface-500">Round Duration:</span> <span className="text-surface-200 ml-1">{Math.floor((session.config?.roundDurationSeconds || 480) / 60)}m</span></div>
          <div><span className="text-surface-500">Current Round:</span> <span className="text-surface-200 ml-1">{session.currentRound || 0}</span></div>
        </div>
      </Card>

      {/* Live State (if active) */}
      {liveState?.active && (
        <Card className="border-brand-500/30 animate-fade-in-up stagger-1">
          <h2 className="font-semibold text-surface-200 mb-3 flex items-center gap-2">
            <Radio className="h-5 w-5 text-green-400 animate-pulse-soft" /> Live State
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <div><span className="text-surface-500">Status:</span> <Badge variant="success" className="ml-1">{liveState.status?.replace(/_/g, ' ')}</Badge></div>
            <div><span className="text-surface-500">Round:</span> <span className="text-surface-200 ml-1">{liveState.currentRound || 0} / {session.config?.numberOfRounds || 5}</span></div>
            <div><span className="text-surface-500">Active Users:</span> <span className="text-surface-200 ml-1">{liveState.participantCount || 0}</span></div>
          </div>
        </Card>
      )}

      {/* Controls */}
      <Card className="animate-fade-in-up stagger-2">
        <h2 className="font-semibold text-surface-200 mb-4 flex items-center gap-2">
          <Play className="h-5 w-5 text-brand-400" /> Controls
        </h2>
        <div className="flex flex-wrap gap-3">
          {session.status === 'scheduled' && (
            <Button onClick={() => hostAction('start')} isLoading={loading === 'start'} className="btn-glow">
              <Play className="h-4 w-4 mr-2" /> Start Session
            </Button>
          )}
          {isActive && session.status !== 'closing_lobby' && (
            <>
              <Button variant="secondary" onClick={() => hostAction('pause')} isLoading={loading === 'pause'}>
                <Pause className="h-4 w-4 mr-2" /> Pause
              </Button>
              <Button variant="secondary" onClick={() => hostAction('resume')} isLoading={loading === 'resume'}>
                <Play className="h-4 w-4 mr-2" /> Resume
              </Button>
            </>
          )}
          {isActive && (
            <Button variant="danger" onClick={() => hostAction('end')} isLoading={loading === 'end'}>
              <StopCircle className="h-4 w-4 mr-2" /> End Session
            </Button>
          )}
          <Button variant="secondary" onClick={() => navigate(`/session/${sessionId}/live`)}>
            <Users className="h-4 w-4 mr-2" /> Go to Live View
          </Button>
        </div>
      </Card>

      {/* Broadcast */}
      {isActive && (
        <Card className="animate-fade-in-up stagger-3">
          <h2 className="font-semibold text-surface-200 mb-3 flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-brand-400" /> Broadcast Message
          </h2>
          <div className="flex gap-2">
            <input
              value={broadcastMsg}
              onChange={e => setBroadcastMsg(e.target.value)}
              placeholder="Type a message to all participants..."
              className="flex-1 rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all duration-200"
              onKeyDown={e => e.key === 'Enter' && sendBroadcast()}
            />
            <Button onClick={sendBroadcast} isLoading={loading === 'broadcast'}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      )}

      {/* Participants */}
      <div className="animate-fade-in-up stagger-4">
        <h2 className="text-lg font-semibold text-surface-100 mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-brand-400" /> Participants ({(participants || []).length})
        </h2>
        {(participants || []).length === 0 ? (
          <Card><p className="text-surface-500 text-sm text-center py-4">No participants yet</p></Card>
        ) : (
          <div className="grid gap-2">
            {(participants || []).map((p: any) => (
              <Card key={p.userId || p.id} className="!p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={p.displayName || p.email || 'User'} size="sm" />
                    <div>
                      <p className="text-sm font-medium text-surface-200">{p.displayName || p.email || 'Participant'}</p>
                      <p className="text-xs text-surface-500">Rounds: {p.roundsCompleted || 0}</p>
                    </div>
                  </div>
                  <Badge variant={p.status === 'in_round' ? 'success' : p.status === 'disconnected' ? 'warning' : 'default'} className="text-xs">
                    {p.status?.replace(/_/g, ' ') || 'registered'}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
