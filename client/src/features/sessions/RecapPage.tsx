import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Avatar from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { CheckCircle, Users, Star, Handshake, ArrowLeft, Calendar, Download, UserCheck, CircleDot, MessageSquare } from 'lucide-react';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';

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
  // Bug 24 (18 May Ali) — set by the server's deduplication so the
  // Mutual Matches card can show "Met 2 times" on a single row instead
  // of two duplicate rows. Optional for backward compat with older
  // payloads (defaults to 1 = met once, no badge).
  meetCount?: number;
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
  totalRounds: number;
  roundsAttended: number;
  connections: Connection[];
  mutualConnections: Connection[];
  // Phase 2 (1 May spec) — deterministic counts from server's meeting_records.
  uniquePeopleMet?: number;
  totalMeetings?: number;
  mutualMatches?: number;
}

// Feature 17 + 18 (13 May spec) — DM button on recap rows. One click lands
// the user directly in the chat panel with the composer ready; no prompt,
// no API round-trip from the recap. MessagesPage handles the routing for
// both the "existing conversation" and "compose new" cases via the
// /messages/new/:userId route.
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

function InterestBadge({ connection }: { connection: Connection }) {
  if (connection.mutualMeetAgain) {
    return (
      <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-rsn-red/10 border border-rsn-red/20 text-rsn-red font-medium">
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

function LateRatingForm({
  matchId, partnerId, partnerName, roundNumber, isManual, isTrio, onRated,
}: {
  matchId: string;
  partnerId: string;
  partnerName: string;
  roundNumber: number;
  // Phase 5 (29 April 2026 spec) — context label so the user knows exactly
  // who they're rating + which conversation. "rate your manual room with
  // this partner" / "Round 3 trio with Charlie" — never an unlabeled rating.
  isManual?: boolean;
  isTrio?: boolean;
  onRated: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [meetAgain, setMeetAgain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const { addToast } = useToastStore();

  if (done) return null;

  const submit = async () => {
    if (rating === 0) return;
    setSubmitting(true);
    try {
      await api.post('/ratings', { matchId, qualityScore: rating, meetAgain, toUserId: partnerId });
      addToast(`Rated ${partnerName}!`, 'success');
      setDone(true);
      onRated();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Failed to submit', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-4 p-3 rounded-xl bg-[#292a2d]">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white font-medium truncate">{partnerName}</p>
        <p className="text-xs text-gray-500">
          {isManual
            ? 'Manual breakout room'
            : `Round ${roundNumber}${isTrio ? ' (trio)' : ''}`}
        </p>
      </div>
      <div className="flex gap-1 shrink-0">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} onClick={() => setRating(n)}>
            <Star className={`h-5 w-5 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-gray-600'}`} />
          </button>
        ))}
      </div>
      <button
        onClick={() => setMeetAgain(!meetAgain)}
        className={`p-2 rounded-lg border shrink-0 ${meetAgain ? 'border-indigo-500 bg-indigo-500/10' : 'border-white/10'}`}
      >
        <Handshake className={`h-4 w-4 ${meetAgain ? 'text-indigo-400' : 'text-gray-500'}`} />
      </button>
      <Button size="sm" onClick={submit} isLoading={submitting} disabled={rating === 0} className="shrink-0">
        Rate
      </Button>
    </div>
  );
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

  const { data: cohostData } = useQuery({
    queryKey: ['session-cohost', sessionId, user?.id],
    queryFn: () => api.get(`/sessions/${sessionId}/cohosts/check`).then(r => r.data.data?.isCohost).catch(() => false),
    enabled: !!sessionId && !!user?.id && session?.hostUserId !== user?.id,
  });
  const isHost = session?.hostUserId === user?.id || cohostData === true;

  const { data: unratedData, refetch: refetchUnrated } = useQuery({
    queryKey: ['unrated-partners', sessionId],
    queryFn: () => api.get(`/ratings/unrated?sessionId=${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
  });

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
      // Fetch both independently — if one fails, still show what we can
      const [peopleRes, statsRes] = await Promise.allSettled([
        api.get(`/ratings/sessions/${sessionId}/people-met`),
        api.get(`/ratings/sessions/${sessionId}/stats`),
      ]);
      if (peopleRes.status === 'fulfilled') {
        setData(peopleRes.value.data.data || null);
      }
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value.data.data || null);
      }
      // Only show error if BOTH failed
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

      {/* Participation summary */}
      {data && data.totalRounds > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200">
          <CircleDot className="h-4 w-4 text-rsn-red shrink-0" />
          <p className="text-sm text-gray-600">
            You attended <span className="font-semibold text-[#1a1a2e]">{data.roundsAttended}</span> round{data.roundsAttended !== 1 ? 's' : ''} out of <span className="font-semibold text-[#1a1a2e]">{data.totalRounds}</span> total
          </p>
        </div>
      )}

      {/* Stats grid — host sees event-level stats, participants see personal stats */}
      {stats && (
        isHost ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Card className="text-center py-4">
              <Star className="h-5 w-5 text-amber-400 mx-auto mb-1" />
              <p className="text-2xl font-bold text-[#1a1a2e]">{stats.avgQualityScore.toFixed(1)}</p>
              <p className="text-xs text-gray-400">Avg Rating</p>
            </Card>
            <Card className="text-center py-4">
              <Handshake className="h-5 w-5 text-indigo-500 mx-auto mb-1" />
              <p className="text-2xl font-bold text-[#1a1a2e]">{stats.mutualMeetAgainCount}</p>
              <p className="text-xs text-gray-400">Mutual Matches (all)</p>
            </Card>
            <Card className="text-center py-4">
              <p className="text-2xl font-bold text-[#1a1a2e]">{stats.totalRatings}</p>
              <p className="text-xs text-gray-400">Total Ratings</p>
            </Card>
          </div>
        ) : (
          // Phase 2 (1 May 2026 spec) — three deterministic metrics from the
          // server's meeting_records aggregate. Stefan's strict definitions:
          //   People Met       = distinct partners (meeting Alice 3 times = 1)
          //   Total Meetings   = every meeting, including repeats
          //   Mutual Matches   = both said yes (BOTH ticked meet-again)
          // All three come from the SAME stored aggregate so they can never
          // drift between renders. Falls back to client-side dedup of
          // connections[] only if the server didn't supply them (older data).
          (() => {
            const peopleMet = data?.uniquePeopleMet
              ?? (data ? new Set(data.connections.map(c => c.userId)).size : 0);
            const totalMeetings = data?.totalMeetings
              ?? (data ? data.connections.length : 0);
            const mutualMatches = data?.mutualMatches
              ?? (data ? data.mutualConnections.length : stats.mutualMeetAgainCount);
            return (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card className="text-center py-4">
                  <Handshake className="h-5 w-5 text-rsn-red mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{peopleMet}</p>
                  <p className="text-xs text-gray-400">People Met</p>
                </Card>
                <Card className="text-center py-4">
                  <Handshake className="h-5 w-5 text-indigo-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{totalMeetings}</p>
                  <p className="text-xs text-gray-400">Total Meetings</p>
                </Card>
                <Card className="text-center py-4">
                  <Handshake className="h-5 w-5 text-emerald-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{mutualMatches}</p>
                  <p className="text-xs text-gray-400">Mutual Matches</p>
                </Card>
                <Card className="text-center py-4">
                  <Star className="h-5 w-5 text-amber-400 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-[#1a1a2e]">{stats.avgQualityScore.toFixed(1)}</p>
                  <p className="text-xs text-gray-400">Avg Rating</p>
                </Card>
              </div>
            );
          })()
        )
      )}

      {/* Unrated conversations — late rating */}
      {unratedData && unratedData.length > 0 && (
        <div className="bg-[#292a2d] rounded-2xl p-5 border border-amber-500/30">
          <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
            <Star className="h-4 w-4" />
            You have unrated conversations
          </h3>
          <div className="space-y-3">
            {unratedData.map((partner: any) => (
              <LateRatingForm
                key={`${partner.matchId}-${partner.partnerId}`}
                matchId={partner.matchId}
                partnerId={partner.partnerId}
                partnerName={partner.partnerDisplayName}
                roundNumber={partner.roundNumber}
                isManual={partner.isManual}
                isTrio={partner.isTrio}
                onRated={() => refetchUnrated()}
              />
            ))}
          </div>
        </div>
      )}

      {/* Mutual connections */}
      {data && data.mutualConnections.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-indigo-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <Handshake className="h-4 w-4 text-indigo-500" />
            Mutual Matches — You both said "meet again"!
          </h3>
          <div className="space-y-3">
            {data.mutualConnections.map(c => (
              <div key={c.userId} className="flex items-center gap-3 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20 hover:bg-indigo-500/10 transition-colors">
                <a href={`/profile/${c.userId}`} className="flex items-center gap-3 flex-1 min-w-0">
                  <Avatar src={c.avatarUrl} name={c.displayName || 'User'} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                      {/* Bug 24 (18 May Ali) — single row per partner; surface
                          the meet count when > 1 so the host doesn't see the
                          same person rendered twice. */}
                      {(c.meetCount ?? 1) > 1 && (
                        <span className="inline-flex items-center text-[10px] font-semibold text-indigo-700 bg-indigo-100 border border-indigo-200 rounded-full px-1.5 py-px">
                          Met {c.meetCount} times
                        </span>
                      )}
                    </div>
                    {(c.jobTitle || c.company) && (
                      <p className="text-xs text-gray-400 truncate">
                        {[c.jobTitle, c.company].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                </a>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1 text-xs text-amber-400">
                    <Star className="h-3 w-3 fill-amber-400" />{c.qualityScore}
                  </div>
                  <Handshake className="h-4 w-4 text-indigo-500" />
                </div>
                <MessagePartnerButton userId={c.userId} displayName={c.displayName} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* All connections grouped by round */}
      {data && data.connections.length > 0 && (() => {
        const byRound = data.connections.reduce<Record<number, typeof data.connections>>((acc, c) => {
          (acc[c.roundNumber] ||= []).push(c);
          return acc;
        }, {});
        const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
        return rounds.map(round => (
          <Card key={round}>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-rsn-red/10 text-rsn-red text-xs font-bold">{round}</span>
              Round {round}
              <span className="text-xs font-normal text-gray-400">· {byRound[round].length} {byRound[round].length === 1 ? 'person' : 'people'}</span>
            </h3>
            <div className="space-y-2">
              {byRound[round].map(c => (
                <div key={`${c.userId}-${c.roundNumber}`} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-100/40 transition-colors">
                  <a href={`/profile/${c.userId}`} className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar src={c.avatarUrl} name={c.displayName || 'User'} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-gray-800 font-medium truncate">{c.displayName}</p>
                        <InterestBadge connection={c} />
                      </div>
                      <p className="text-xs text-gray-400">
                        {c.jobTitle && `${c.jobTitle}`}
                        {c.company && ` @ ${c.company}`}
                      </p>
                    </div>
                  </a>
                  <div className="flex items-center gap-3 shrink-0">
                    {c.qualityScore > 0 && (
                      <div className="flex items-center gap-1 text-xs text-amber-400">
                        <Star className="h-3 w-3 fill-amber-400" />{c.qualityScore}
                      </div>
                    )}
                  </div>
                  <MessagePartnerButton userId={c.userId} displayName={c.displayName} />
                </div>
              ))}
            </div>
          </Card>
        ));
      })()}

      {/* Empty state */}
      {data && data.connections.length === 0 && (
        <Card className="text-center py-8">
          <Users className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No connections recorded for this session.</p>
        </Card>
      )}

      {/* Host-only: full event recap */}
      {isHost && <HostRecapSection sessionId={sessionId!} />}

      <div className="flex justify-center gap-3">
        {session?.podId && (
          <Button onClick={() => navigate(`/pods/${session.podId}`)} variant="secondary" className="px-8">
            Back to Pod
          </Button>
        )}
        <Button onClick={() => navigate('/sessions')} className="px-8">
          Back to Events
        </Button>
      </div>
    </div>
  );
}

/* ─── Host Event-Wide Recap ──────────────────────────────────────────────── */

function HostRecapSection({ sessionId }: { sessionId: string }) {
  const [hostData, setHostData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/sessions/${sessionId}/host-recap`).then(r => {
      setHostData(r.data.data);
    }).catch(err => {
      // Host recap fetch can fail for non-hosts (403) — that's expected,
      // the section just stays empty. For other errors, log so the host
      // dev tools surface the issue rather than seeing a silent blank page.
      const code = err?.response?.data?.error?.code;
      if (code !== 'AUTH_FORBIDDEN') {
        console.warn('host recap fetch failed', { sessionId, code, err });
      }
    }).finally(() => setLoading(false));
  }, [sessionId]);

  const exportCSV = () => {
    if (!hostData) return;
    const rows: string[] = ['Round,Room,Participant A,Participant B,Participant C,Status'];
    for (const m of hostData.matches) {
      rows.push(`${m.roundNumber},${m.roomId || ''},${m.nameA},${m.nameB},${m.nameC || ''},${m.status}`);
    }
    rows.push('');
    rows.push('Participant,Email,Rounds Completed,Status,No Show');
    for (const p of hostData.participants) {
      rows.push(`${p.displayName},${p.email},${p.roundsCompleted},${p.status},${p.isNoShow}`);
    }
    if (hostData.feedback.length > 0) {
      rows.push('');
      rows.push('Feedback From,Feedback,Submitted At');
      for (const f of hostData.feedback) {
        rows.push(`${f.displayName},"${f.feedback.replace(/"/g, '""')}",${f.createdAt}`);
      }
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `event-recap-${sessionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return null;
  if (!hostData) return null;

  // Group matches by round
  const byRound: Record<number, any[]> = {};
  for (const m of hostData.matches) {
    (byRound[m.roundNumber] ||= []).push(m);
  }
  const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);

  return (
    <>
      <div className="border-t border-gray-200 pt-6 mt-2">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800">Host Recap — Full Breakdown</h2>
          <Button size="sm" variant="secondary" onClick={exportCSV}>
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Card className="text-center py-3">
            <p className="text-xl font-bold text-gray-800">{hostData.participants.length}</p>
            <p className="text-xs text-gray-400">Total Participants</p>
          </Card>
          <Card className="text-center py-3">
            <p className="text-xl font-bold text-gray-800">{hostData.stats.totalRatings}</p>
            <p className="text-xs text-gray-400">Ratings Submitted</p>
          </Card>
          <Card className="text-center py-3">
            <p className="text-xl font-bold text-gray-800">{Number(hostData.stats.avgQuality).toFixed(1)}</p>
            <p className="text-xs text-gray-400">Avg Quality</p>
          </Card>
        </div>

        {/* Round-by-round match breakdown */}
        {rounds.map(round => (
          <Card key={round} className="mb-3">
            <h3 className="text-sm font-semibold text-gray-600 mb-2">Round {round} — {byRound[round].length} room{byRound[round].length !== 1 ? 's' : ''}</h3>
            <div className="space-y-1.5">
              {byRound[round].map((m: any) => (
                <div key={m.id} className="flex items-center gap-2 text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-1.5">
                  <span className="font-medium">{m.nameA}</span>
                  <span className="text-gray-400">&</span>
                  <span className="font-medium">{m.nameB}</span>
                  {m.nameC && <><span className="text-gray-400">&</span><span className="font-medium">{m.nameC}</span></>}
                  <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${m.status === 'completed' ? 'bg-emerald-50 text-emerald-600' : m.status === 'no_show' ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-500'}`}>
                    {m.status}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        ))}

        {/* Participant feedback */}
        {hostData.feedback.length > 0 && (
          <Card>
            <h3 className="text-sm font-semibold text-gray-600 mb-3">Participant Feedback ({hostData.feedback.length})</h3>
            <div className="space-y-3">
              {hostData.feedback.map((f: any) => (
                <div key={f.userId} className="bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-xs font-medium text-gray-500 mb-1">{f.displayName}</p>
                  <p className="text-sm text-gray-700">{f.feedback}</p>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
