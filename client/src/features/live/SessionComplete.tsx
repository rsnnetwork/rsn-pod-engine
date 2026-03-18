import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Avatar from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { CheckCircle, Users, Star, Heart, ArrowRight, UserCheck, CircleDot } from 'lucide-react';
import api from '@/lib/api';

interface Connection {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  company?: string;
  jobTitle?: string;
  qualityScore: number;
  meetAgain: boolean;
  theirMeetAgain: boolean;
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

function InterestBadge({ connection }: { connection: Connection }) {
  if (connection.mutualMeetAgain) {
    return (
      <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-rsn-red/10 border border-rsn-red/20 text-rsn-red font-medium">
        <Heart className="h-3 w-3 fill-rsn-red" />
        <span>Mutual Match!</span>
      </div>
    );
  }
  if (connection.meetAgain && !connection.theirMeetAgain) {
    return (
      <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-600">
        <UserCheck className="h-3 w-3" />
        <span>You expressed interest</span>
      </div>
    );
  }
  if (!connection.meetAgain && connection.theirMeetAgain) {
    return (
      <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-600">
        <UserCheck className="h-3 w-3" />
        <span>They expressed interest</span>
      </div>
    );
  }
  return null;
}

export default function SessionComplete({ sessionId }: Props) {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [mutualConnections, setMutualConnections] = useState<Connection[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [totalRounds, setTotalRounds] = useState(0);
  const [roundsAttended, setRoundsAttended] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  const fetchRecap = async () => {
    setLoading(true);
    setFetchError(false);
    try {
      const [peopleRes, statsRes] = await Promise.allSettled([
        api.get(`/ratings/sessions/${sessionId}/people-met`),
        api.get(`/ratings/sessions/${sessionId}/stats`),
      ]);
      if (peopleRes.status === 'fulfilled') {
        const d = peopleRes.value.data.data;
        setConnections(d?.connections || []);
        setMutualConnections(d?.mutualConnections || []);
        setTotalRounds(d?.totalRounds || 0);
        setRoundsAttended(d?.roundsAttended || 0);
      }
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value.data.data || null);
      }
      if (peopleRes.status === 'rejected' && statsRes.status === 'rejected') {
        setFetchError(true);
      }
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
            {/* Participation summary */}
            {totalRounds > 0 && (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200">
                <CircleDot className="h-4 w-4 text-rsn-red shrink-0" />
                <p className="text-sm text-gray-600">
                  You attended <span className="font-semibold text-[#1a1a2e]">{roundsAttended}</span> round{roundsAttended !== 1 ? 's' : ''} out of <span className="font-semibold text-[#1a1a2e]">{totalRounds}</span> total
                </p>
              </div>
            )}

            {/* Stats summary */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card className="text-center py-3">
                  <Users className="h-5 w-5 text-rsn-red mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{connections.length}</p>
                  <p className="text-xs text-gray-400">People Met</p>
                </Card>
                <Card className="text-center py-3">
                  <Heart className="h-5 w-5 text-rsn-red mx-auto mb-1" />
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
                <h3 className="text-sm font-semibold text-rsn-red uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Heart className="h-4 w-4 fill-rsn-red" />
                  Mutual Matches
                </h3>
                <div className="space-y-3">
                  {mutualConnections.map(c => (
                    <a key={c.userId} href={`/profile/${c.userId}`} className="flex items-center gap-3 p-2 rounded-lg bg-rsn-red/5 border border-rsn-red/20 hover:bg-rsn-red/10 transition-colors">
                      <Avatar src={c.avatarUrl} name={c.displayName || 'User'} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                        {(c.jobTitle || c.company) && (
                          <p className="text-xs text-gray-400 truncate">
                            {[c.jobTitle, c.company].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                      <Heart className="h-4 w-4 text-rsn-red fill-rsn-red shrink-0" />
                    </a>
                  ))}
                </div>
              </Card>
            )}

            {/* All people met — grouped by round */}
            {connections.length > 0 && (() => {
              const byRound = connections.reduce<Record<number, Connection[]>>((acc, c) => {
                (acc[c.roundNumber] ||= []).push(c);
                return acc;
              }, {});
              const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
              return rounds.map(round => (
                <Card key={round}>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-rsn-red/10 text-rsn-red text-[10px] font-bold">{round}</span>
                    Round {round}
                  </h3>
                  <div className="space-y-2">
                    {byRound[round].map(c => (
                      <a key={`${c.userId}-${c.roundNumber}`} href={`/profile/${c.userId}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50">
                        <Avatar src={c.avatarUrl} name={c.displayName || 'User'} size="sm" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                            <InterestBadge connection={c} />
                          </div>
                        </div>
                        {c.qualityScore > 0 && (
                          <div className="flex items-center gap-1 text-xs text-amber-400">
                            <Star className="h-3 w-3 fill-amber-400" />
                            {c.qualityScore}
                          </div>
                        )}
                      </a>
                    ))}
                  </div>
                </Card>
              ));
            })()}
          </>
        )}

        {/* Post-event feedback */}
        <FeedbackPrompt sessionId={sessionId} />

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

/* ─── Post-Event Feedback Prompt ─────────────────────────────────────────── */

function FeedbackPrompt({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/sessions/${sessionId}/feedback`, { feedback: text.trim() });
      setSubmitted(true);
    } catch {
      // silently fail
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <Card className="text-center py-4">
        <CheckCircle className="h-5 w-5 text-emerald-500 mx-auto mb-1" />
        <p className="text-sm text-gray-600">Thanks for your feedback!</p>
      </Card>
    );
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Is there anything you want to add?</h3>
      <p className="text-xs text-gray-400 mb-3">Share your thoughts about this event — what worked, what could be better.</p>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Your feedback..."
        maxLength={2000}
        rows={3}
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rsn-red/30 resize-none"
      />
      <div className="flex justify-end mt-2">
        <Button size="sm" onClick={handleSubmit} disabled={!text.trim() || submitting}>
          {submitting ? 'Sending...' : 'Submit Feedback'}
        </Button>
      </div>
    </Card>
  );
}
