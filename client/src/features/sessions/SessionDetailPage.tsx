import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calendar, Users, Play, Clock, UserPlus, UserMinus, Settings, CheckCircle } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

export default function SessionDetailPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
  });

  const { data: participants } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then(r => r.data.data ?? []),
    enabled: !!sessionId,
  });

  const isHost = session?.hostUserId === user?.id || user?.role === 'admin';
  const isRegistered = (participants || []).some((p: any) => p.userId === user?.id);

  const registerMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Registered for session!', 'success');
    },
    onError: () => addToast('Failed to register', 'error'),
  });

  const unregisterMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Unregistered from session', 'success');
    },
    onError: () => addToast('Failed to unregister', 'error'),
  });

  if (isLoading) return <PageLoader />;
  if (!session) return <p className="text-surface-400 text-center py-20">Session not found</p>;

  const statusVariant = session.status === 'scheduled' ? 'info'
    : session.status === 'lobby_open' || session.status === 'round_active' ? 'success'
    : session.status === 'completed' ? 'default' : 'warning';

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <button onClick={() => navigate('/sessions')} className="flex items-center gap-2 text-surface-400 hover:text-surface-200 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Sessions
      </button>

      {/* Session Info */}
      <Card className="animate-fade-in-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-surface-100">{session.title || 'Session'}</h1>
            {session.description && <p className="text-surface-400 mt-1 text-sm">{session.description}</p>}
            <p className="text-surface-500 mt-2 text-sm flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {session.scheduledAt ? new Date(session.scheduledAt).toLocaleString() : 'No date set'}
            </p>
          </div>
          <Badge variant={statusVariant}>{session.status?.replace(/_/g, ' ')}</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t border-surface-800">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-surface-400 mb-1">
              <Users className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-surface-100">{(participants || []).length}</p>
            <p className="text-xs text-surface-500">participants</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-surface-400 mb-1">
              <Settings className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-surface-100">{session.config?.numberOfRounds || 5}</p>
            <p className="text-xs text-surface-500">rounds</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-surface-400 mb-1">
              <Clock className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-surface-100">{Math.floor((session.config?.roundDurationSeconds || 480) / 60)}m</p>
            <p className="text-xs text-surface-500">per round</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-surface-400 mb-1">
              <Users className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-surface-100">{session.config?.maxParticipants || 500}</p>
            <p className="text-xs text-surface-500">max capacity</p>
          </div>
        </div>
      </Card>

      {/* Actions */}
      <div className="flex flex-wrap gap-3 animate-fade-in-up stagger-1">
        {session.status === 'scheduled' && !isRegistered && (
          <Button onClick={() => registerMutation.mutate()} isLoading={registerMutation.isPending} className="btn-glow">
            <UserPlus className="h-4 w-4 mr-2" /> Register
          </Button>
        )}
        {session.status === 'scheduled' && isRegistered && (
          <>
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              <CheckCircle className="h-4 w-4" /> Registered
            </div>
            <Button variant="ghost" onClick={() => unregisterMutation.mutate()} isLoading={unregisterMutation.isPending}>
              <UserMinus className="h-4 w-4 mr-2" /> Unregister
            </Button>
          </>
        )}
        {(session.status === 'scheduled' || session.status === 'lobby_open' || session.status === 'round_active') && (
          <Button variant={isRegistered ? 'primary' : 'secondary'} onClick={() => navigate(`/session/${sessionId}/live`)}>
            <Play className="h-4 w-4 mr-2" /> Join Session
          </Button>
        )}
        {isHost && (
          <Button variant="secondary" onClick={() => navigate(`/session/${sessionId}/host`)}>
            <Settings className="h-4 w-4 mr-2" /> Host Controls
          </Button>
        )}
        {session.status === 'completed' && (
          <Button variant="secondary" onClick={() => navigate(`/sessions/${sessionId}/recap`)}>
            View Recap
          </Button>
        )}
      </div>

      {/* Participants */}
      <div className="animate-fade-in-up stagger-2">
        <h2 className="text-lg font-semibold text-surface-100 mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-brand-400" /> Participants ({(participants || []).length})
        </h2>
        {(participants || []).length === 0 ? (
          <Card>
            <p className="text-surface-500 text-sm text-center py-4">No participants yet. Be the first to register!</p>
          </Card>
        ) : (
          <div className="grid gap-2">
            {(participants || []).map((p: any) => (
              <Card key={p.userId || p.id} className="!p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={p.displayName || p.email || 'User'} size="sm" />
                    <div>
                      <p className="text-sm font-medium text-surface-200">{p.displayName || p.email || 'Participant'}</p>
                      <p className="text-xs text-surface-500">{p.status || 'registered'}</p>
                    </div>
                  </div>
                  {p.userId === session.hostUserId && (
                    <Badge variant="brand" className="text-xs">Host</Badge>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
