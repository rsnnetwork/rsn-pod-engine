import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Avatar from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { CheckCircle, Users, Star, Heart, ArrowLeft, Calendar, Download } from 'lucide-react';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

interface Connection {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  company?: string;
  jobTitle?: string;
  qualityScore: number;
  meetAgain: boolean;
  mutualMeetAgain: boolean;
  roundNumber: number;
}

interface Stats {
  totalRatings: number;
  avgQualityScore: number;
  meetAgainRate: number;
  mutualMeetAgainCount: number;
}

interface PeopleMetData {
  sessionId: string;
  sessionTitle: string;
  sessionDate: string;
  connections: Connection[];
  mutualConnections: Connection[];
}

export default function RecapPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
  });

  const isHost = session?.hostUserId === user?.id;

  const [data, setData] = useState<PeopleMetData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const fetchRecap = async () => {
    if (!sessionId) return;
    setLoading(true);
    setFetchError(false);
    try {
      const [peopleRes, statsRes] = await Promise.all([
        api.get(`/ratings/sessions/${sessionId}/people-met`),
        api.get(`/ratings/sessions/${sessionId}/stats`),
      ]);
      setData(peopleRes.data.data || null);
      setStats(statsRes.data.data || null);
    } catch {
      setFetchError(true);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchRecap();
  }, [sessionId]);

  const handleExport = async () => {
    if (!sessionId) return;
    setExportLoading(true);
    try {
      const res = await api.get(`/ratings/sessions/${sessionId}/export`);
      const blob = new Blob([JSON.stringify(res.data.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* silently fail */ }
    setExportLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <p className="text-gray-500">Could not load event recap.</p>
          <Button size="sm" variant="secondary" onClick={fetchRecap}>Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors">
          <ArrowLeft className="h-4 w-4" />
          <span className="text-sm">Back</span>
        </button>
        {isHost && (
          <Button variant="secondary" size="sm" onClick={handleExport} isLoading={exportLoading}>
            <Download className="h-4 w-4 mr-1" /> Export
          </Button>
        )}
      </div>

      <Card>
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
            <CheckCircle className="h-6 w-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#1a1a2e]">
              {data?.sessionTitle || 'Event Recap'}
            </h1>
            {data?.sessionDate && (
              <p className="text-sm text-gray-400 flex items-center gap-1 mt-1">
                <Calendar className="h-3.5 w-3.5" />
                {new Date(data.sessionDate).toLocaleDateString(undefined, {
                  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                })}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Stats grid */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="text-center py-4">
            <Users className="h-5 w-5 text-indigo-600 mx-auto mb-1" />
            <p className="text-2xl font-bold text-[#1a1a2e]">{data?.connections.length || 0}</p>
            <p className="text-xs text-gray-400">People Met</p>
          </Card>
          <Card className="text-center py-4">
            <Heart className="h-5 w-5 text-pink-400 mx-auto mb-1" />
            <p className="text-2xl font-bold text-[#1a1a2e]">{stats.mutualMeetAgainCount}</p>
            <p className="text-xs text-gray-400">Mutual Matches</p>
          </Card>
          <Card className="text-center py-4">
            <Star className="h-5 w-5 text-amber-400 mx-auto mb-1" />
            <p className="text-2xl font-bold text-[#1a1a2e]">{stats.avgQualityScore.toFixed(1)}</p>
            <p className="text-xs text-gray-400">Avg Rating</p>
          </Card>
          <Card className="text-center py-4">
            <p className="text-2xl font-bold text-[#1a1a2e]">{stats.totalRatings}</p>
            <p className="text-xs text-gray-400">Total Ratings</p>
          </Card>
        </div>
      )}

      {/* Mutual connections */}
      {data && data.mutualConnections.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider mb-4">
            Mutual Connections — You both said "meet again"!
          </h3>
          <div className="space-y-3">
            {data.mutualConnections.map(c => (
              <div key={c.userId} className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                <Avatar name={c.displayName || 'User'} size="md" />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                  {(c.jobTitle || c.company) && (
                    <p className="text-xs text-gray-400 truncate">
                      {[c.jobTitle, c.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1 text-xs text-amber-400">
                    <Star className="h-3 w-3 fill-amber-400" />{c.qualityScore}
                  </div>
                  <Heart className="h-4 w-4 text-emerald-400 fill-emerald-400" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* All connections by round */}
      {data && data.connections.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
            All Connections
          </h3>
          <div className="space-y-2">
            {data.connections.map(c => (
              <div key={`${c.userId}-${c.roundNumber}`} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-100/40 transition-colors">
                <Avatar name={c.displayName || 'User'} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                  <p className="text-xs text-gray-400">
                    Round {c.roundNumber}
                    {c.jobTitle && ` · ${c.jobTitle}`}
                    {c.company && ` @ ${c.company}`}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {c.qualityScore > 0 && (
                    <div className="flex items-center gap-1 text-xs text-amber-400">
                      <Star className="h-3 w-3 fill-amber-400" />{c.qualityScore}
                    </div>
                  )}
                  {c.meetAgain && <Heart className="h-3.5 w-3.5 text-pink-400" />}
                  {c.mutualMeetAgain && <Heart className="h-3.5 w-3.5 text-emerald-400 fill-emerald-400" />}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Empty state */}
      {data && data.connections.length === 0 && (
        <Card className="text-center py-8">
          <Users className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No connections recorded for this session.</p>
        </Card>
      )}

      <div className="flex justify-center">
        <Button onClick={() => navigate('/sessions')} className="px-8">
          Back to Events
        </Button>
      </div>
    </div>
  );
}
