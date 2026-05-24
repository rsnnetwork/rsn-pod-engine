import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import Avatar from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { CheckCircle, Users, Star, Handshake, ArrowRight, UserCheck, CircleDot, MessageSquare } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

// Feature 17 + 18 (13 May spec) — DM button on recap rows. One click lands
// the user directly in the chat panel with the composer ready; no prompt,
// no API round-trip from the recap. MessagesPage handles the routing for
// both the "existing conversation" and "compose new" cases via the
// /messages/new/:userId route. Same component used by SessionComplete and
// RecapPage so behaviour is uniform across both recap views.
function MessagePartnerButton({ userId, displayName }: { userId: string; displayName: string }) {
  const navigate = useNavigate();
  const openConversation = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/messages/new/${userId}`);
  };
  return (
    <button
      onClick={openConversation}
      title={`Message ${displayName || 'this user'}`}
      className="shrink-0 inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded-md border border-indigo-200 hover:bg-indigo-50 transition-colors"
      data-testid={`recap-dm-button-${userId}`}
    >
      <MessageSquare className="h-3.5 w-3.5" /> Message
    </button>
  );
}

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
  isManual: boolean;
}

// Phase 1 (5 May 2026 spec compliance) — these stats are now derived
// per-user from the recap endpoint instead of session-wide aggregates.
// Each participant sees their own counts; "mutual matches" no longer
// shows the same number for everyone.
interface Stats {
  uniquePeopleMet: number;
  totalMeetings: number;
  mutualMatches: number;
  avgQualityScore: number;
  meetAgainRate: number;
}

interface Props { sessionId: string; }

function InterestBadge({ connection }: { connection: Connection }) {
  if (connection.mutualMeetAgain) {
    return (
      <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-600 font-medium">
        <Handshake className="h-3 w-3 text-indigo-500" />
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
  // #15 (23 May) — bonus rounds added live via "Another Round" (same recap-
  // endpoint field the Full Recap uses, so both views agree).
  const [bonusRoundsAdded, setBonusRoundsAdded] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
    meta: { entities: sessionId ? [E.session(sessionId)] : [] },
  });
  const podId = session?.podId;

  // #15 (23 May, Ali) — a bonus round is one added live via "Another Round".
  // The recap reports how many were added (bonusRoundsAdded); any round beyond
  // (totalRounds − bonusRoundsAdded) is therefore a bonus round.
  const isBonusRound = (r: number) =>
    bonusRoundsAdded > 0 && totalRounds > 0 && r > totalRounds - bonusRoundsAdded;

  const fetchRecap = async () => {
    setLoading(true);
    setFetchError(false);
    try {
      // Phase 1 (5 May spec) — single per-user endpoint covers everything
      // we display. The old session-wide /ratings stats endpoint was
      // showing the same "12 mutual matches" to every participant —
      // recap returns per-user counts derived from meeting_records.
      const peopleRes = await api.get(`/ratings/sessions/${sessionId}/people-met`);
      const d = peopleRes.data.data;
      const conns: Connection[] = d?.connections || [];
      setConnections(conns);
      setMutualConnections(d?.mutualConnections || []);
      setTotalRounds(d?.totalRounds || 0);
      setRoundsAttended(d?.roundsAttended || 0);
      setBonusRoundsAdded(d?.bonusRoundsAdded || 0);

      // Per-user derived stats. avgQualityScore and meetAgainRate are
      // averaged across only THIS user's ratings (they gave), not the
      // whole event. mutualMatches comes from the canonical aggregate.
      const ratedConns = conns.filter(c => c.qualityScore > 0);
      const avgQualityScore = ratedConns.length > 0
        ? ratedConns.reduce((sum, c) => sum + c.qualityScore, 0) / ratedConns.length
        : 0;
      const meetAgainRate = ratedConns.length > 0
        ? ratedConns.filter(c => c.meetAgain).length / ratedConns.length
        : 0;

      setStats({
        uniquePeopleMet: d?.uniquePeopleMet ?? new Set(conns.map(c => c.userId)).size,
        totalMeetings: d?.totalMeetings ?? conns.length,
        mutualMatches: d?.mutualMatches ?? (d?.mutualConnections?.length || 0),
        avgQualityScore,
        meetAgainRate,
      });
    } catch {
      setFetchError(true);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchRecap();
  }, [sessionId]);

  return (
    <div className="flex-1 overflow-y-auto p-4 bg-white">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center bg-gray-50 rounded-2xl p-8 border border-gray-200">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-emerald-500/20 text-emerald-500 mb-4">
            <CheckCircle className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Event ended</h2>
          <p className="text-gray-500">Here's your recap</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : fetchError ? (
          <div className="text-center bg-gray-50 rounded-2xl p-8 border border-gray-200">
            <p className="text-gray-500 mb-3">Could not load your recap.</p>
            <Button size="sm" variant="secondary" onClick={fetchRecap}>Retry</Button>
          </div>
        ) : (
          <>
            {/* Participation summary */}
            {totalRounds > 0 && (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200">
                <CircleDot className="h-4 w-4 text-blue-500 shrink-0" />
                <p className="text-sm text-gray-500">
                  You attended <span className="font-semibold text-gray-900">{roundsAttended}</span> round{roundsAttended !== 1 ? 's' : ''} out of <span className="font-semibold text-gray-900">{totalRounds}</span> total
                  {bonusRoundsAdded > 0 && (
                    <> <span className="text-xs text-gray-500">({totalRounds - bonusRoundsAdded} original + {bonusRoundsAdded} bonus)</span></>
                  )}
                </p>
              </div>
            )}

            {/* Stats summary */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="text-center py-3 bg-gray-50 rounded-xl p-4 border border-gray-200">
                  <Users className="h-5 w-5 text-blue-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-gray-900">{stats.uniquePeopleMet}</p>
                  <p className="text-xs text-gray-500">People Met</p>
                </div>
                <div className="text-center py-3 bg-gray-50 rounded-xl p-4 border border-gray-200">
                  <Handshake className="h-5 w-5 text-indigo-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-gray-900">{stats.mutualMatches}</p>
                  <p className="text-xs text-gray-500">Mutual Matches</p>
                </div>
                <div className="text-center py-3 bg-gray-50 rounded-xl p-4 border border-gray-200">
                  <Star className="h-5 w-5 text-amber-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-gray-900">{stats.avgQualityScore.toFixed(1)}</p>
                  <p className="text-xs text-gray-500">Avg Rating</p>
                </div>
                <div className="text-center py-3 bg-gray-50 rounded-xl p-4 border border-gray-200">
                  <p className="text-2xl font-bold text-gray-900">{Math.round(stats.meetAgainRate * 100)}%</p>
                  <p className="text-xs text-gray-500">Meet Again Rate</p>
                </div>
              </div>
            )}

            {/* Mutual connections */}
            {mutualConnections.length > 0 && (
              <div className="bg-gray-50 rounded-2xl p-6 border border-gray-200">
                <h3 className="text-sm font-semibold text-indigo-600 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Handshake className="h-4 w-4 text-indigo-500" />
                  Mutual Matches
                </h3>
                <div className="space-y-3">
                  {mutualConnections.map(c => (
                    <div key={c.userId} className="flex items-center gap-3 p-2 rounded-lg bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 transition-colors">
                      <a href={`/profile/${c.userId}`} className="flex items-center gap-3 flex-1 min-w-0">
                        <Avatar src={c.avatarUrl} name={c.displayName || 'User'} size="sm" />
                        <div className="flex-1 min-w-0">
                          <p className="text-gray-900 font-medium truncate">{c.displayName}</p>
                          {(c.jobTitle || c.company) && (
                            <p className="text-xs text-gray-500 truncate">
                              {[c.jobTitle, c.company].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </div>
                      </a>
                      <Handshake className="h-4 w-4 text-indigo-500 shrink-0" />
                      <MessagePartnerButton userId={c.userId} displayName={c.displayName} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* All people met — grouped by round, with manual rooms separate (#5) */}
            {connections.length > 0 && (() => {
              const roundConns = connections.filter(c => !c.isManual);
              const manualConns = connections.filter(c => c.isManual);
              const byRound = roundConns.reduce<Record<number, Connection[]>>((acc, c) => {
                (acc[c.roundNumber] ||= []).push(c);
                return acc;
              }, {});
              const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
              const row = (c: Connection) => (
                <div key={`${c.userId}-${c.roundNumber}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-100">
                  <a href={`/profile/${c.userId}`} className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar src={c.avatarUrl} name={c.displayName || 'User'} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-gray-900 font-medium truncate">{c.displayName}</p>
                        <InterestBadge connection={c} />
                      </div>
                    </div>
                  </a>
                  {c.qualityScore > 0 && (
                    <div className="flex items-center gap-1 text-xs text-amber-500">
                      <Star className="h-3 w-3 fill-amber-400" />
                      {c.qualityScore}
                    </div>
                  )}
                  <MessagePartnerButton userId={c.userId} displayName={c.displayName} />
                </div>
              );
              return (
                <>
                  {rounds.map(round => (
                    <div key={round} className="bg-gray-50 rounded-2xl p-6 border border-gray-200">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-50 text-blue-600 text-[10px] font-bold">{round}</span>
                        Round {round}
                        {isBonusRound(round) && (
                          <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal">Bonus round</span>
                        )}
                      </h3>
                      <div className="space-y-2">{byRound[round].map(row)}</div>
                    </div>
                  ))}
                  {/* #5 (24 May) — manual breakout rooms are NOT a numbered round */}
                  {manualConns.length > 0 && (
                    <div className="bg-gray-50 rounded-2xl p-6 border border-gray-200">
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-50 text-emerald-600 text-[10px] font-bold">M</span>
                        Manual rooms
                      </h3>
                      <div className="space-y-2">{manualConns.map(row)}</div>
                    </div>
                  )}
                </>
              );
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
          {podId && (
            <Button onClick={() => navigate(`/pods/${podId}`)} variant="secondary" className="flex-1">
              Back to Pod
            </Button>
          )}
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
      <div className="text-center py-4 bg-gray-50 rounded-2xl p-6 border border-gray-200">
        <CheckCircle className="h-5 w-5 text-emerald-500 mx-auto mb-1" />
        <p className="text-sm text-gray-500">Thanks for your feedback!</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 rounded-2xl p-6 border border-gray-200">
      <h3 className="text-sm font-semibold text-gray-900 mb-2">Is there anything you want to add?</h3>
      <p className="text-xs text-gray-500 mb-3">Share your thoughts about this event — what worked, what could be better.</p>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Your feedback..."
        maxLength={2000}
        rows={3}
        style={{ color: '#000000' }}
        className="w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-none placeholder-gray-400"
      />
      <div className="flex justify-end mt-2">
        <Button size="sm" onClick={handleSubmit} disabled={!text.trim() || submitting}>
          {submitting ? 'Sending...' : 'Submit Feedback'}
        </Button>
      </div>
    </div>
  );
}
