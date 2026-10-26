import { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calendar, Users, Play, Clock, UserPlus, UserMinus, Settings, CheckCircle, Pencil, Trash2, Mail, AlertTriangle, CopyPlus, Shield, ShieldCheck, Radio } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { formatDateTime, LOCAL_TIME_LABEL } from '@/lib/utils';
import { liveKindOf, resolveEventFormat } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { personHref } from '@/features/reason/human/profile-text';
import { sessionStatusLabel, sessionStatusColor, sessionStatusPhase } from './statusConfig';
import MessageParticipantsPanel from './MessageParticipantsPanel';
import StartGroupChatCard from './StartGroupChatCard';
import EventChatHistory from './EventChatHistory';
import EditEventModal from './EditEventModal';
import { eventFacts, eventFactsLine } from './event-format-form';
import InvitePickerSheet from '@/features/invites/InvitePickerSheet';
import InviteStatusList from '@/features/invites/InviteStatusList';

/** The icon over each figure under an event's title. */
const FACT_ICONS: Record<string, typeof Users> = { numberOfRounds: Settings, roundMinutes: Clock, durationMinutes: Clock, maxParticipants: Users };

/** A way back off the event page: a link, 44px tall. */
const BACK_LINK = 'inline-flex min-h-[44px] items-center gap-2 text-sm text-gray-500 hover:text-gray-800 transition-colors';

export default function SessionDetailPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  // Edit Event is its own react-hook-form sheet that follows the event type (EditEventModal, 26 Oct 2026).
  const [editOpen, setEditOpen] = useState(false);
  // The invite sheet (features/invites, 26 Oct 2026). A new event lands here with ?invite=1 (Schedule an Event), and
  // the sheet is open on arrival for whoever may invite.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const askedToInvite = searchParams.get('invite') === '1';
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Close overflow menu on Escape only — click-outside handled by backdrop overlay
  // (more reliable than document mousedown listener which raced with menu items)
  useEffect(() => {
    if (!overflowOpen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverflowOpen(false); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [overflowOpen]);

  const { data: session, isLoading, error: sessionError } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    retry: (failureCount, err: any) => {
      // Don't retry 403s — access is intentionally denied
      if (err?.response?.status === 403) return false;
      return failureCount < 3;
    },
    meta: { entities: sessionId ? [E.session(sessionId)] : [] },
  });

  const { data: pod } = useQuery({
    queryKey: ['pod', session?.podId],
    queryFn: () => api.get(`/pods/${session.podId}`).then(r => r.data.data),
    enabled: !!session?.podId,
    meta: { entities: session?.podId ? [E.pod(session.podId)] : [] },
  });

  const { data: participants } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then(r => r.data.data ?? []),
    enabled: !!sessionId,
    // R2 safety net (20 May 2026 — live-test post-mortem). Entity-tag
    // fanout is the primary refresh path, but missed emits at scattered
    // session_participants write sites left clients showing stale lists
    // for minutes (e.g. Saif missing Wasim during the 20 May test).
    // 30 s background refetch is a belt-and-braces guarantee that any
    // missed emit self-heals within 30 s — one HTTP request per viewer
    // per half-minute, negligible at RSN's scale.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    meta: { entities: sessionId ? [E.session(sessionId), E.sessionParticipants(sessionId)] : [] },
  });

  const isHost = session?.hostUserId === user?.id;
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  // Where the event is in its life: before, live, done (completed) or cancelled.
  const phase = sessionStatusPhase(session?.status);

  // S16 (Ali, 6 Jun) — co-host management lives HERE too, not only in the
  // live page's participant drawer: the host plans co-hosts before the
  // event. Mirrors the drawer's rule (any acting host may manage; the
  // server authorizes via canActAsHost and keeps the director-only guard
  // for platform-admin targets). viewerIsCohost comes from the participants
  // payload so a formal co-host visiting this page gets the toggles too.
  const viewerIsCohost = (participants || []).some((p: any) => p.userId === user?.id && p.isCohost);
  // S16.1 (Ali) — a finished event has no co-hosts to manage: the toggle
  // renders only while the event can still happen / is happening.
  const sessionOver = session?.status === 'completed' || session?.status === 'cancelled';
  const canManageCohosts = !sessionOver && (isHost || user?.role === 'super_admin' || viewerIsCohost);
  // Who may invite (the server's rule: the host, a co-host, an admin), while the event can still take people.
  const mayInvite = (isHost || isAdmin || viewerIsCohost) && (phase === 'pre' || phase === 'live');
  const pickerOpen = inviteOpen || (askedToInvite && mayInvite);
  const closePicker = () => {
    setInviteOpen(false);
    // Closed once, it stays closed: the address no longer asks for it, so a refresh does not open it again.
    if (askedToInvite) {
      setSearchParams((now) => {
        const next = new URLSearchParams(now);
        next.delete('invite');
        return next;
      }, { replace: true });
    }
  };
  const [cohostBusy, setCohostBusy] = useState<string | null>(null);
  const toggleCohost = async (targetUserId: string, currentlyCohost: boolean) => {
    setCohostBusy(targetUserId);
    try {
      if (currentlyCohost) await api.delete(`/sessions/${sessionId}/cohosts/${targetUserId}`);
      else await api.post(`/sessions/${sessionId}/cohosts/${targetUserId}`);
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      addToast(currentlyCohost ? 'Co-host removed' : 'Co-host added — they will have host controls when they join', 'success');
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Failed to update co-host', 'error');
    } finally {
      setCohostBusy(null);
    }
  };

  const { data: participantCounts } = useQuery({
    queryKey: ['session-participant-counts', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participant-counts`).then(r => r.data.data),
    enabled: !!sessionId && (isHost || isAdmin),
    meta: { entities: sessionId ? [E.session(sessionId), E.sessionParticipants(sessionId)] : [] },
  });
  // The server's "All" counts pending invites as well. They are listed on the Invitations card now, not below.
  const participantTotal: number | undefined = participantCounts
    ? participantCounts.total - (participantCounts.pendingInvites ?? 0)
    : undefined;
  // The people going (the server's rule: registered and not removed or left), apart from the host: the card's "Going".
  const goingIds: string[] = (participants || [])
    .filter((p: { userId: string; status: string }) => p.status !== 'removed' && p.status !== 'left' && p.userId !== session?.hostUserId)
    .map((p: { userId: string }) => p.userId);
  const isRegistered = (participants || []).some((p: any) => p.userId === user?.id && p.status !== 'removed');
  const isMember = !!pod?.memberRole || isAdmin;
  const isRestrictedPod = pod?.visibility === 'invite_only' || pod?.visibility === 'private';
  const canRegister = isMember || !isRestrictedPod;
  const [autoRegistering, setAutoRegistering] = useState(false);
  // Bug 13 (April 19) — block the auto-register useEffect after an EXPLICIT
  // unregister click. Without this, unregister → isRegistered flips false →
  // useEffect fires → re-registers automatically (the visible "flash" of
  // Register-then-back-to-Registered the user reported).
  const explicitlyUnregisteredRef = useRef(false);

  // Auto-register: if user landed here and isn't registered, register them immediately.
  // Shows loading state so "Register" button never flashes. Skipped after an
  // explicit unregister (see ref above).
  //
  // Failure handling: SESSION_ALREADY_REGISTERED is idempotent (fine, silent).
  // Anything else (private pod, event ended, etc.) gets a visible toast — we
  // used to swallow these errors which made the user think the auto-register
  // worked when it didn't, then the Register button appeared mysteriously.
  useEffect(() => {
    if (explicitlyUnregisteredRef.current) return;
    // An event that has ended or was cancelled takes nobody (the server refuses, and the refusal showed as an error
    // to anyone opening it who had not registered: a pod member reading the chat, someone following a link).
    if (phase === 'done' || phase === 'cancelled') return;
    if (session && user && participants && !isRegistered && !autoRegistering && sessionId) {
      setAutoRegistering(true);
      api.post(`/sessions/${sessionId}/register`).then(() => {
        qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      }).catch(err => {
        const code = err?.response?.data?.error?.code;
        if (code === 'SESSION_ALREADY_REGISTERED') return; // idempotent — silent
        const msg = err?.response?.data?.error?.message;
        if (msg) addToast(msg, 'error');
      })
        .finally(() => setAutoRegistering(false));
    }
  }, [session?.id, user?.id, isRegistered]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}`),
    onSuccess: () => {
      addToast('Event deleted', 'success');
      navigate('/sessions');
    },
    onError: () => addToast('Failed to delete event', 'error'),
  });

  const openEdit = () => setEditOpen(true);

  const registerMutation = useMutation({
    mutationFn: () => api.post(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      addToast('Registered for event!', 'success');
    },
    onError: (err: any) => {
      const errCode = err?.response?.data?.error?.code;
      if (errCode === 'SESSION_ALREADY_REGISTERED') {
        addToast('You\'re already registered for this event!', 'info');
        qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      } else {
        const msg = err?.response?.data?.error?.message || 'Failed to register';
        addToast(msg, 'error');
      }
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () => api.post('/sessions', {
      podId: session?.podId,
      title: `${session?.title || 'Event'} (copy)`,
      description: session?.description || '',
      scheduledAt: null,
      config: session?.config,
    }),
    onSuccess: (res: any) => {
      const newId = res.data?.data?.id;
      addToast('Event duplicated! Edit the new event to set a date.', 'success');
      if (newId) navigate(`/sessions/${newId}`);
    },
    onError: () => addToast('Failed to duplicate event', 'error'),
  });

  const unregisterMutation = useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}/register`),
    onSuccess: () => {
      // Bug 13 — block the auto-register useEffect from firing after this.
      explicitlyUnregisteredRef.current = true;
      qc.refetchQueries({ queryKey: ['session-participants', sessionId] });
      qc.refetchQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['my-sessions'] });
      addToast('Unregistered from event', 'success');
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error?.message || 'Failed to unregister';
      addToast(msg, 'error');
    },
  });

  if (isLoading) return <PageLoader />;

  // 403 — user isn't registered, not a pod member, and the pod isn't public.
  // Show a clean access-denied card instead of the broken "0 participants" fallback.
  if ((sessionError as any)?.response?.status === 403) {
    // The way out goes home (For You): the old one went to a dashboard address that has no page.
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link to="/" className={BACK_LINK}>
            <ArrowLeft className="h-4 w-4" /> Back to For You
          </Link>
        </div>
        <Card className="animate-fade-in-up">
          <div className="flex flex-col items-center text-center py-10 px-4">
            <div className="h-14 w-14 rounded-full bg-amber-100 flex items-center justify-center mb-4">
              <AlertTriangle className="h-7 w-7 text-amber-600" />
            </div>
            <h1 className="text-xl font-bold text-[#1a1a2e] mb-2">Access restricted</h1>
            <p className="text-gray-500 text-sm max-w-md">
              You don't have access to this event. Ask the host for an invite or join the pod to see details.
            </p>
            <Button variant="primary" onClick={() => navigate('/')} className="mt-6">
              Back to For You
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!session) return <p className="text-gray-500 text-center py-20">Event not found</p>;

  const statusVariant = sessionStatusColor(session.status);
  // The facts follow the event's type: a video meeting has a length, not rounds (25 Oct walkthrough).
  const eventFormat = resolveEventFormat(session);
  const isRoundsEvent = liveKindOf(eventFormat) === 'rounds';
  const facts = eventFacts(eventFormat, session.config);
  // The people who may run the event: its host and co-hosts, the pod's director or host, admins. The server has the
  // last word (the panel hides itself for anyone else); this only spares everyone else a loading card.
  const mayRunEvent = isHost || viewerIsCohost || isAdmin || pod?.memberRole === 'director' || pod?.memberRole === 'host';
  const showAfterEventTools = phase === 'done' && mayRunEvent;
  // A video meeting has no rounds to recap: its recap is who took part, further down this page.
  const openRecap = () => {
    if (isRoundsEvent) navigate(`/sessions/${sessionId}/recap`);
    else document.getElementById('participants')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Back: to the pod first, then the events list. One path after any event (COM-05): the live event, then this
          page (the recap, the chat, message everyone), then the pod. */}
      <nav aria-label="Back" className="flex flex-wrap items-center gap-x-5">
        {session.podId && pod ? (
          <>
            <Link to={`/pods/${session.podId}`} className={BACK_LINK}>
              <ArrowLeft className="h-4 w-4" /> Back to pod
            </Link>
            <Link to="/sessions" className={BACK_LINK}>Events</Link>
          </>
        ) : (
          <Link to="/sessions" className={BACK_LINK}>
            <ArrowLeft className="h-4 w-4" /> Back to Events
          </Link>
        )}
      </nav>

      {/* Session Info */}
      <Card className="animate-fade-in-up">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a2e]">{session.title || 'Event'}</h1>
            {session.description && <p className="text-gray-500 mt-1 text-sm">{session.description}</p>}
            <p className="text-gray-400 mt-2 text-sm flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {session.scheduledAt ? `${formatDateTime(session.scheduledAt)} ${LOCAL_TIME_LABEL}` : 'No date set'}
            </p>
            <p className="text-gray-500 mt-1 text-sm flex items-center gap-1.5">
              <Radio className="h-4 w-4 shrink-0" />
              {eventFactsLine(eventFormat, session.config)}
            </p>
          </div>
          <Badge variant={statusVariant}>{sessionStatusLabel(session.status)}</Badge>
        </div>

        <div className={`grid ${facts.length + 1 === 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'} gap-4 mt-4 pt-4 border-t border-gray-200`}>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-gray-500 mb-1">
              <Users className="h-4 w-4" />
            </div>
            <p className="text-lg font-bold text-[#1a1a2e]">{(participants || []).length}</p>
            <p className="text-xs text-gray-400">{(participants || []).length === 1 ? 'participant' : 'participants'}</p>
          </div>
          {facts.map((fact) => {
            const Icon = FACT_ICONS[fact.key] ?? Settings;
            return (
              <div key={fact.key} className="text-center">
                <div className="flex items-center justify-center gap-1 text-gray-500 mb-1">
                  <Icon className="h-4 w-4" />
                </div>
                <p className="text-lg font-bold text-[#1a1a2e]">{fact.value}</p>
                <p className="text-xs text-gray-400">{fact.caption}</p>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Late-join warning */}
      {(session.status === 'lobby_open' || session.status === 'round_active' || session.status === 'round_rating' || session.status === 'round_transition') && !isRegistered && (
        <div className="flex items-start gap-3 rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3 animate-fade-in-up stagger-1">
          <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-300">Event in progress</p>
            <p className="text-xs text-amber-400/80 mt-0.5">
              {isRoundsEvent ? (
                <>
                  {session.status === 'round_active' ? `Round ${session.currentRound || '?'} is currently active. ` : ''}
                  You can still join — you'll be placed in the lobby until the next round begins.
                </>
              ) : 'You can still join. Everyone is together in the main room.'}
            </p>
          </div>
        </div>
      )}

      {/* Actions — status-driven primary + overflow menu (April 17 item #10) */}
      <div className="flex flex-col gap-3 animate-fade-in-up stagger-1">
        {/* Primary Actions */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Non-host participant flows: Register / Join Late / Pending-invite notice */}
          {!isHost && sessionStatusPhase(session.status) !== 'done' && sessionStatusPhase(session.status) !== 'cancelled' && !isRegistered && (
            canRegister ? (
              <Button onClick={() => registerMutation.mutate()} isLoading={registerMutation.isPending} className="btn-glow">
                <UserPlus className="h-4 w-4 mr-2" /> {session.status === 'scheduled' ? 'Register' : 'Join Late'}
              </Button>
            ) : (
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
                <Mail className="h-4 w-4 flex-shrink-0" />
                <span>You have a pending invite — accept it from your <button onClick={() => navigate('/invites')} className="underline font-medium hover:text-amber-900">Invites page</button> to join this event.</span>
              </div>
            )
          )}
          {!isHost && isRegistered && sessionStatusPhase(session.status) === 'live' && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              <CheckCircle className="h-4 w-4" /> Registered
            </div>
          )}
          {!isHost && isRegistered && sessionStatusPhase(session.status) === 'pre' && (
            <>
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
                <CheckCircle className="h-4 w-4" /> Registered
              </div>
              <Button variant="ghost" onClick={() => {
                if (!confirm('Are you sure you want to unregister? You will need to register again or get a new invite to rejoin.')) return;
                unregisterMutation.mutate();
              }} isLoading={unregisterMutation.isPending}>
                <UserMinus className="h-4 w-4 mr-2" /> Unregister
              </Button>
            </>
          )}

          {/* Status-driven primary button:
              pre  -> Enter Event   (host Go Live / participant Enter Event)
              live -> Enter Live Event
              done -> View Recap
           */}
          {(isRegistered || isHost) && sessionStatusPhase(session.status) === 'pre' && (
            <Button
              variant="primary"
              onClick={() => navigate(`/session/${sessionId}/live`)}
              className="btn-glow"
            >
              <Play className="h-4 w-4 mr-2" />
              {isHost ? 'Go Live' : 'Enter Event'}
            </Button>
          )}
          {(isRegistered || isHost) && sessionStatusPhase(session.status) === 'live' && (
            <Button
              variant="primary"
              onClick={() => navigate(`/session/${sessionId}/live`)}
              className="btn-glow"
            >
              <Play className="h-4 w-4 mr-2" /> Enter Live Event
            </Button>
          )}
          {phase === 'done' && (
            <Button variant="primary" className="btn-glow" onClick={openRecap}>
              {isRoundsEvent ? 'View recap' : 'Who took part'}
            </Button>
          )}

          {/* Overflow menu for host/admin. Host Controls button intentionally removed —
              live host controls live inside the /live page once the host clicks Enter Live Event.
              Co-hosts send invites too (26 Oct 2026), so they get the invite button and nothing else here. */}
          {(isHost || isAdmin || mayInvite) && sessionStatusPhase(session.status) !== 'cancelled' && (
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              {mayInvite && (
                // Labelled on every width and 44px tall: on a phone it was a 36px envelope (25 Oct walkthrough).
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  className="min-h-[44px] px-4 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 flex items-center gap-2 text-sm font-semibold text-[#1a1a2e] transition-colors"
                >
                  <Mail className="h-4 w-4" /> Invite people
                </button>
              )}
              {(isHost || isAdmin) && (
                <>
                  <button
                    type="button"
                    onClick={() => duplicateMutation.mutate()}
                    disabled={duplicateMutation.isPending}
                    className="min-h-[44px] min-w-[44px] px-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors disabled:opacity-60"
                    title="Duplicate this event"
                  >
                    <CopyPlus className="h-4 w-4" /> <span className="hidden sm:inline">Copy</span>
                  </button>
                  {sessionStatusPhase(session.status) === 'pre' && (
                    <button
                      type="button"
                      onClick={() => openEdit()}
                      className="min-h-[44px] min-w-[44px] px-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
                      title="Edit event"
                    >
                      <Pencil className="h-4 w-4" /> <span className="hidden sm:inline">Edit</span>
                    </button>
                  )}
                  {sessionStatusPhase(session.status) !== 'live' && (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm('Delete this event? This cannot be undone.')) deleteMutation.mutate();
                      }}
                      disabled={deleteMutation.isPending}
                      className="min-h-[44px] min-w-[44px] px-3 rounded-xl border border-red-200 bg-white hover:bg-red-50 flex items-center justify-center gap-1.5 text-sm font-medium text-red-600 hover:text-red-700 transition-colors disabled:opacity-60"
                      title="Delete event"
                    >
                      <Trash2 className="h-4 w-4" /> <span className="hidden sm:inline">Delete</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* After the event, for the people who run it: message everyone who took part, or start a group chat with them. */}
      {showAfterEventTools && sessionId && (
        <div data-testid="after-event-tools" className="grid gap-3 empty:hidden animate-fade-in-up stagger-1">
          <MessageParticipantsPanel sessionId={sessionId} />
          <StartGroupChatCard sessionId={sessionId} />
        </div>
      )}

      {/* The event's chat: kept with it once it has ended; inside the live event while it runs. */}
      {sessionId && (phase === 'done' || phase === 'live') && (
        <div className="animate-fade-in-up stagger-2">
          <EventChatHistory sessionId={sessionId} live={phase === 'live'} canEnterLive={isRegistered || isHost} />
        </div>
      )}

      {/* Who is invited and who declined, for the people who run the event, while it can still take people. It
          replaces the "Pending Invites" chip and the grey rows that sat at the end of the participants. */}
      {mayInvite && sessionId && (
        <InviteStatusList
          target={{ type: 'session', sessionId, podId: session.podId ?? null }}
          present={goingIds}
          presentCount={goingIds.length}
          onInvite={() => setInviteOpen(true)}
        />
      )}

      {/* Participants */}
      <div id="participants" className="scroll-mt-4 animate-fade-in-up stagger-2">
        <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-rsn-red" /> Participants ({participantTotal ?? (participants || []).filter((p: any) => p.status !== 'removed' && p.userId !== session.hostUserId).length})
        </h2>

        {/* Status summary row (host/admin only) */}
        {(isHost || isAdmin) && participantCounts && (
          <div className="flex flex-wrap gap-2 mb-3">
            {[
              { key: null, label: 'All', count: participantTotal, color: 'bg-gray-100 text-gray-700 border-gray-200' },
              ...(participantCounts.registered > 0 ? [{ key: 'registered', label: 'Registered', count: participantCounts.registered, color: 'bg-blue-50 text-blue-700 border-blue-200' }] : []),
              ...(participantCounts.checked_in > 0 ? [{ key: 'checked_in', label: 'Checked In', count: participantCounts.checked_in, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' }] : []),
              ...(participantCounts.in_lobby > 0 ? [{ key: 'in_lobby', label: 'In Main Room', count: participantCounts.in_lobby, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' }] : []),
              ...(participantCounts.in_round > 0 ? [{ key: 'in_round', label: 'In Round', count: participantCounts.in_round, color: 'bg-green-50 text-green-700 border-green-200' }] : []),
              ...(participantCounts.disconnected > 0 ? [{ key: 'disconnected', label: 'Disconnected', count: participantCounts.disconnected, color: 'bg-amber-50 text-amber-700 border-amber-200' }] : []),
              ...(participantCounts.left > 0 ? [{ key: 'left', label: 'Left', count: participantCounts.left, color: 'bg-gray-100 text-gray-500 border-gray-200' }] : []),
              ...(participantCounts.no_show > 0 ? [{ key: 'no_show', label: 'No Show', count: participantCounts.no_show, color: 'bg-red-50 text-red-600 border-red-200' }] : []),
            ].map((tab: any) => (
              <button
                key={tab.key ?? 'all'}
                onClick={() => setStatusFilter(tab.key)}
                className={`flex min-h-[44px] items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                  statusFilter === tab.key
                    ? 'ring-2 ring-rsn-red/30 border-rsn-red ' + tab.color
                    : tab.color + ' hover:opacity-80'
                }`}
              >
                <span>{tab.label}</span>
                <span className="font-bold">{tab.count}</span>
              </button>
            ))}
          </div>
        )}

        {(participants || []).length === 0 ? (
          <Card>
            <p className="text-gray-400 text-sm text-center py-4">No participants yet. Be the first to register!</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {/* Host/Director card — always visible at the top of the list, for
                every viewer (member, admin, host themselves). The host is
                NOT a participant in the matching sense (they organise, they
                don't get matched), but the UI must make their role obvious.
                Resolved from session.hostUserId by looking up the matching
                row in the participants array. Shown regardless of the host's
                session_participants.status — if they briefly clicked Leave
                during a pre-event lobby and their row is `left`, they're
                still the event director.  May 21 Ali — "director still not
                shown ... should be visible to every other participant too." */}
            {(() => {
              const hostRow = (participants || []).find((p: any) => p.userId === session.hostUserId);
              if (!hostRow) return null;
              return (
                <Card key={`host-${hostRow.userId}`} className="!p-4 border-rsn-red/30 bg-rsn-red/5">
                  <div className="flex items-center justify-between">
                    <Link to={personHref(hostRow.userId, 'Events')} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                      <Avatar src={hostRow.avatarUrl} name={hostRow.displayName || hostRow.email || 'Host'} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-gray-800">{hostRow.displayName || hostRow.email || 'Host'}</p>
                        <p className="text-xs text-gray-400">Host / Director</p>
                      </div>
                    </Link>
                    <Badge variant="brand" className="text-xs">Host</Badge>
                  </div>
                </Card>
              );
            })()}
            {(participants || [])
              .filter((p: any) => p.status !== 'removed' && p.userId !== session.hostUserId)
              .filter((p: any) => statusFilter === null || p.status === statusFilter)
              .map((p: any) => {
              const statusLabel =
                  (p.status === 'registered' || p.status === 'left' || p.status === 'checked_in') ? 'Member'
                : p.status === 'in_lobby' ? 'In Main Room'
                : p.status === 'in_round' ? 'In Round'
                : p.status === 'disconnected' ? 'Reconnecting...'
                : p.status === 'no_show' ? 'No Show'
                : p.status || 'Member';
              return (
                <Card key={p.userId || p.id} className="!p-4">
                  <div className="flex items-center justify-between">
                    <Link to={personHref(p.userId || p.id, 'Events')} className="flex items-center gap-3 hover:opacity-80 transition-opacity min-w-0">
                      <Avatar src={p.avatarUrl} name={p.displayName || p.email || 'User'} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{p.displayName || p.email || 'Participant'}</p>
                        <p className="text-xs text-gray-400">{p.isCohost ? 'Co-Host' : statusLabel}</p>
                      </div>
                    </Link>
                    {/* S16 — pre-event co-host management on the event page.
                        Same semantics as the live drawer's shield toggle. */}
                    <div className="flex items-center gap-2 shrink-0">
                      {p.isCohost && (
                        <Badge variant="info" className="text-xs flex items-center gap-1">
                          <ShieldCheck className="h-3 w-3" /> Co-Host
                        </Badge>
                      )}
                      {canManageCohosts && p.userId !== user?.id && (
                        <button
                          onClick={() => toggleCohost(p.userId, !!p.isCohost)}
                          disabled={cohostBusy === p.userId}
                          title={p.isCohost ? 'Remove co-host' : 'Make co-host'}
                          aria-label={p.isCohost ? `Remove ${p.displayName || 'user'} as co-host` : `Make ${p.displayName || 'user'} a co-host`}
                          className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
                            p.isCohost ? 'text-blue-600 hover:bg-blue-50' : 'text-gray-400 hover:bg-gray-100'
                          }`}
                        >
                          <Shield className="h-5 w-5" />
                        </button>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Invite people: the invite sheet (the event's pod, your connections, by email, a link) */}
      {sessionId && (
        <InvitePickerSheet
          open={pickerOpen}
          onClose={closePicker}
          target={{ type: 'session', sessionId, podId: session.podId ?? null }}
          podName={pod?.name}
          linkCap={session.config?.maxParticipants}
        />
      )}

      {/* Edit Event: the same type picker and settings as Schedule an Event */}
      <EditEventModal open={editOpen} onClose={() => setEditOpen(false)} session={session} podType={pod?.podType} isAdmin={isAdmin} />
    </div>
  );
}
