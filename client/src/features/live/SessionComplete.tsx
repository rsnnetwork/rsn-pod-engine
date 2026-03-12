import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Avatar from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { CheckCircle, Users, Star, Heart, ArrowRight } from 'lucide-react';
import api from '@/lib/api';

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

interface Props { sessionId: string; }

export default function SessionComplete({ sessionId }: Props) {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [mutualConnections, setMutualConnections] = useState<Connection[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  const fetchRecap = async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const [peopleRes, statsRes] = await Promise.all([
        api.get(`/ratings/sessions/${sessionId}/people-met`),
        api.get(`/ratings/sessions/${sessionId}/stats`),
      ]);
      setConnections(peopleRes.data.data?.connections || []);
      setMutualConnections(peopleRes.data.data?.mutualConnections || []);
      setStats(statsRes.data.data || null);
    } catch {
      setFetchError(true);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchRecap();
  }, [sessionId]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <Card className="text-center">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-emerald-500/20 text-emerald-400 mb-4">
            <CheckCircle className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Event Complete!</h2>
          <p className="text-gray-500">Great networking! Here's your recap.</p>
        </Card>

        {loading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : fetchError ? (
          <Card className="text-center">
            <p className="text-gray-500 mb-3">Could not load your recap.</p>
            <Button size="sm" variant="secondary" onClick={fetchRecap}>Retry</Button>
          </Card>
        ) : (
          <>
            {/* Stats summary */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card className="text-center py-3">
                  <Users className="h-5 w-5 text-indigo-600 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{connections.length}</p>
                  <p className="text-xs text-gray-400">People Met</p>
                </Card>
                <Card className="text-center py-3">
                  <Heart className="h-5 w-5 text-pink-400 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{stats.mutualMeetAgainCount}</p>
                  <p className="text-xs text-gray-400">Mutual Matches</p>
                </Card>
                <Card className="text-center py-3">
                  <Star className="h-5 w-5 text-amber-400 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{stats.avgQualityScore.toFixed(1)}</p>
                  <p className="text-xs text-gray-400">Avg Rating</p>
                </Card>
                <Card className="text-center py-3">
                  <p className="text-2xl font-bold text-[#1a1a2e]">{Math.round(stats.meetAgainRate * 100)}%</p>
                  <p className="text-xs text-gray-400">Meet Again Rate</p>
                </Card>
              </div>
            )}

            {/* Mutual connections */}
            {mutualConnections.length > 0 && (
              <Card>
                <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider mb-3">
                  Mutual Connections
                </h3>
                <div className="space-y-3">
                  {mutualConnections.map(c => (
                    <div key={c.userId} className="flex items-center gap-3 p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                      <Avatar name={c.displayName || 'User'} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                        {(c.jobTitle || c.company) && (
                          <p className="text-xs text-gray-400 truncate">
                            {[c.jobTitle, c.company].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                      <Heart className="h-4 w-4 text-emerald-400 fill-emerald-400 shrink-0" />
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* All people met */}
            {connections.length > 0 && (
              <Card>
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Everyone You Met
                </h3>
                <div className="space-y-2">
                  {connections.map(c => (
                    <div key={`${c.userId}-${c.roundNumber}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50">
                      <Avatar name={c.displayName || 'User'} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                        <p className="text-xs text-gray-400">Round {c.roundNumber}</p>
                      </div>
                      {c.qualityScore > 0 && (
                        <div className="flex items-center gap-1 text-xs text-amber-400">
                          <Star className="h-3 w-3 fill-amber-400" />
                          {c.qualityScore}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <Button onClick={() => navigate(`/sessions/${sessionId}/recap`)} variant="secondary" className="flex-1">
            Full Recap <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
          <Button onClick={() => navigate('/sessions')} className="flex-1">
            Back to Events
          </Button>
        </div>
      </div>
    </div>
  );
}
