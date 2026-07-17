// ─── Matches Page ────────────────────────────────────────────────────────────
//
// REASON platform v1 Phase 1 (17 Jul 2026) — the standing match check.
// Stefan's flow, verbatim: after onboarding the app checks if there are any
// matches. If there are, "we matched you with this profile" + I want to meet
// (the other side accepts or declines — nobody is introduced until both say
// yes). If there are none, three choices: join the next RSN, invite more, or
// find other people based on profiling — with a side note that new arrivals
// who fit will trigger a notification.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  Sparkles, Calendar, UserPlus, Compass, ArrowLeft, Check, Bell, MessageSquare,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';

interface PlatformMatch {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: string | null;
  company: string | null;
  reason: string;
  score: number;
}

interface PlatformMatchesResult {
  matches: PlatformMatch[];
  profileIncomplete: boolean;
  nextEvent: { id: string; title: string; scheduledAt: string } | null;
}

export default function MatchesPage() {
  const [browse, setBrowse] = useState(false);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<PlatformMatchesResult>({
    queryKey: ['platformMatches', browse],
    queryFn: () => api.get(`/matches/platform${browse ? '?browse=1' : ''}`).then(r => r.data.data),
  });

  const expressInterest = async (m: PlatformMatch) => {
    if (sending || requested.has(m.userId)) return;
    setSending(m.userId);
    try {
      await api.post(`/matches/platform/${m.userId}/interest`);
      setRequested(prev => new Set(prev).add(m.userId));
      addToast(`${m.displayName || 'They'} will be notified — if they say yes too, a chat opens.`, 'success');
      queryClient.invalidateQueries({ queryKey: ['platformMatches'] });
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message;
      addToast(msg || 'Could not send that right now — try again in a moment.', 'error');
    } finally {
      setSending(null);
    }
  };

  if (isLoading) return <PageLoader />;

  const matches = data?.matches ?? [];
  const nextEvent = data?.nextEvent ?? null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Matches</h1>
          <p className="text-gray-500 text-sm mt-1">
            {browse ? 'People close to your profile' : "People who fit what you're looking for"}
          </p>
        </div>
        <Sparkles className="h-8 w-8 text-rsn-red" />
      </div>

      {browse && (
        <button
          onClick={() => setBrowse(false)}
          className="flex items-center gap-1.5 min-h-[44px] text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to your matches
        </button>
      )}

      {data?.profileIncomplete ? (
        <Card className="animate-fade-in-up">
          <div className="flex flex-col items-center text-center gap-3 py-6">
            <Sparkles className="h-10 w-10 text-rsn-red" />
            <h2 className="font-semibold text-gray-900">Tell us who you'd like to meet</h2>
            <p className="text-sm text-gray-500 max-w-sm">
              Finish your onboarding chat so we know who you are and who you're looking
              for — then we can start matching you.
            </p>
            <Button onClick={() => navigate('/onboarding')} className="min-h-[44px]">
              Complete your profile
            </Button>
          </div>
        </Card>
      ) : matches.length > 0 ? (
        <div className="grid gap-3 animate-fade-in-up">
          {matches.map(m => (
            <Card key={m.userId} className="card-hover">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                <Link to={`/profile/${m.userId}`} className="flex items-center gap-3 hover:opacity-80 transition-opacity min-w-0">
                  <Avatar src={m.avatarUrl} name={m.displayName || 'User'} size="md" />
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{m.displayName || 'Member'}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {[m.professionalRole, m.company].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </Link>
                {requested.has(m.userId) ? (
                  <span className="flex items-center gap-1.5 text-sm text-emerald-600 font-medium min-h-[44px] sm:min-h-0">
                    <Check className="h-4 w-4" /> Introduction requested
                  </span>
                ) : (
                  <Button
                    onClick={() => expressInterest(m)}
                    disabled={sending === m.userId}
                    size="sm"
                    className="min-h-[44px] shrink-0"
                  >
                    <MessageSquare className="h-4 w-4 mr-1.5" />
                    {sending === m.userId ? 'Sending…' : 'I want to meet'}
                  </Button>
                )}
              </div>
              <p className="text-sm text-gray-600 mt-3 border-t border-gray-100 pt-3">{m.reason}</p>
            </Card>
          ))}
          <p className="flex items-center gap-2 text-xs text-gray-400 px-1">
            <Bell className="h-3.5 w-3.5 shrink-0" />
            When you both say yes, we introduce you and a chat opens.
          </p>
        </div>
      ) : (
        <div className="space-y-3 animate-fade-in-up">
          <Card>
            <div className="text-center py-4">
              <h2 className="font-semibold text-gray-900">No matches right now</h2>
              <p className="text-sm text-gray-500 mt-1">
                Here's what you can do in the meantime.
              </p>
            </div>
          </Card>

          <Card className="card-hover">
            <Link to={nextEvent ? `/sessions/${nextEvent.id}` : '/sessions'} className="flex items-center gap-4 min-h-[44px]">
              <div className="h-10 w-10 rounded-full bg-rsn-red-light flex items-center justify-center shrink-0">
                <Calendar className="h-5 w-5 text-rsn-red" />
              </div>
              <div className="min-w-0">
                <p className="font-medium text-gray-900">Join the next RSN</p>
                <p className="text-xs text-gray-500 truncate">
                  {nextEvent
                    ? `${nextEvent.title} · ${new Date(nextEvent.scheduledAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                    : 'See upcoming events'}
                </p>
              </div>
            </Link>
          </Card>

          <Card className="card-hover">
            <Link to="/invites" className="flex items-center gap-4 min-h-[44px]">
              <div className="h-10 w-10 rounded-full bg-rsn-red-light flex items-center justify-center shrink-0">
                <UserPlus className="h-5 w-5 text-rsn-red" />
              </div>
              <div>
                <p className="font-medium text-gray-900">Invite people you'd like here</p>
                <p className="text-xs text-gray-500">More members means better matches</p>
              </div>
            </Link>
          </Card>

          <Card className="card-hover">
            <button onClick={() => setBrowse(true)} className="flex items-center gap-4 w-full text-left min-h-[44px]">
              <div className="h-10 w-10 rounded-full bg-rsn-red-light flex items-center justify-center shrink-0">
                <Compass className="h-5 w-5 text-rsn-red" />
              </div>
              <div>
                <p className="font-medium text-gray-900">Browse people near your profile</p>
                <p className="text-xs text-gray-500">A wider look based on what you told us</p>
              </div>
            </button>
          </Card>

          <p className="flex items-center gap-2 text-xs text-gray-400 px-1">
            <Bell className="h-3.5 w-3.5 shrink-0" />
            New people join all the time — we'll notify you when someone who fits arrives.
          </p>
        </div>
      )}
    </div>
  );
}
