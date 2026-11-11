import { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calendar, Users, Play, Clock, UserMinus, Settings, CheckCircle, Pencil, Mail, AlertTriangle, CopyPlus, Shield, ShieldCheck, Radio, CircleDashed, LayoutGrid } from 'lucide-react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { eventWhen } from '@/lib/event-time';
import { eventDurationMinutes, liveKindOf, resolveEventFormat } from '@rsn/shared';
import AddToCalendar from '@/components/calendar/AddToCalendar';
import { eventEntry, icsFile } from '@/components/calendar/calendar-links';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { personHref } from '@/features/reason/human/profile-text';
import { sessionStatusLabel, sessionStatusColor, sessionStatusPhase, isEventLifecycleChip, lifecycleColor, lifecycleLabel } from './statusConfig';
import MessageParticipantsPanel from './MessageParticipantsPanel';
import StartGroupChatCard from './StartGroupChatCard';
import EventChatHistory from './EventChatHistory';
import EditEventModal from './EditEventModal';
import { eventFacts, eventFactsLine, eventPlace, presetNameOf } from './event-format-form';
import EventPlace from './EventPlace';
import { EventImageHeader } from './EventImage';
import { useMatchingPresets } from './useMatchingChoices';
import InvitePickerSheet from '@/features/invites/InvitePickerSheet';
import InviteStatusList from '@/features/invites/InviteStatusList';
import { useConfirm } from '@/hooks/useConfirm';
import EventAccessActions, { ACCESS_COPY, type EventAccess } from './EventAccessActions';
import EventJoinRequestsCard from './EventJoinRequestsCard';
import EndEventButton from './EndEventButton';
import { duplicateCircleField, eventCircleLine } from './circle-preset';
import { circleErrorSentence } from '@/features/circles/useCircleActions';
import OrganiserSettings from './OrganiserSettings';
import EventHistoryPanel from './history/EventHistoryPanel';
import EventReportCard from './report/EventReportCard';
import { useEventGroups } from './groups/useEventGroups';
import ParticipantGroupControl from './groups/ParticipantGroupControl';
import WaitlistCard from './waitlist/WaitlistCard';
import { WAITLIST_COPY, registerBody, waitlistedPosition } from './waitlist/waitlist-text';
import { useEventQuestions } from './questions/useEventQuestions';
import MyEventAnswersSheet from './questions/MyEventAnswersSheet';
import MyAnswersRow from './questions/MyAnswersRow';
import AnswerChips from './questions/AnswerChips';
import type { GivenAnswers } from './questions/EventAnswersForm';
import { needsAnswers, registerBodyWith } from './questions/question-form';

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
  const { ask, confirmDialog } = useConfirm();
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
    // Part 3 Task 8: the access block carries the waiting list (full, my number), which session:<id>:waitlist moves.
    meta: { entities: sessionId ? [E.session(sessionId), E.sessionWaitlist(sessionId)] : [] },
  });

  const { data: pod } = useQuery({
    queryKey: ['pod', session?.podId],
    queryFn: () => api.get(`/pods/${session.podId}`).then(r => r.data.data),
    enabled: !!session?.podId,
    meta: { entities: session?.podId ? [E.pod(session.podId)] : [] },
  });

  // Part 3 Task 8: someone only on the waiting list opens the event page, never its attendee list or live state (the
  // server refuses both). The list is read once they hold a place: a promotion clears their number (session:<id>), which
  // turns this read on, and the page reads "Registered" without a refresh.
  const waitingInLine = session?.access?.waitlist?.position != null;
  const { data: participants } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then(r => r.data.data ?? []),
    enabled: !!sessionId && !waitingInLine,
    retry: (failureCount, err: unknown) => (err as { response?: { status?: number } })?.response?.status !== 403 && failureCount < 3,
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
  // A super admin may end any live event (10 Nov 2026, F7): the platform role decides, never attendance.
  const mayEndForEveryone = user?.role === 'super_admin' && phase === 'live';
  // The preset the facts line names (30 Oct 2026): "Speed networking · Founders and investors · …".
  const { data: presets } = useMatchingPresets();

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
  // Part 2 Task 11: a draft is seen only by the people running it; it takes no invites, no Go Live, no calendar entry.
  const isDraft = session?.lifecycle === 'draft';
  // Who may invite (the server's rule: the host, a co-host, an admin), while the event can still take people.
  const mayInvite = (isHost || isAdmin || viewerIsCohost) && (phase === 'pre' || phase === 'live') && !isDraft;
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
  // The people who may run the event: its host and co-hosts, the pod's director or host, admins. The server has the
  // last word (each organiser card hides itself for anyone it refuses); this only spares everyone else the requests.
  const mayRunEvent = isHost || viewerIsCohost || isAdmin || pod?.memberRole === 'director' || pod?.memberRole === 'host';
  const roundsEvent = !!session && liveKindOf(resolveEventFormat(session)) === 'rounds';
  // Part 2 Task 11: the event's matching groups, read once for the groups card and the participant list's group chips.
  const groupsView = useEventGroups(sessionId ?? '', !!sessionId && mayRunEvent && roundsEvent);
  // Part 3 Task 10: the event's extra matching questions. The server shapes the read per viewer: the viewer's own answers
  // ("Your answers"), and for organisers everyone's (the participant list's answer chips). Refused reads draw nothing.
  const questionsView = useEventQuestions(sessionId ?? '', !!sessionId && !!user && roundsEvent);
  // "Before you join": opened when registering is refused for a group or a required answer (EVENT_GROUP_REQUIRED,
  // EVENT_ANSWERS_REQUIRED), then Register again with what the sheet gave.
  const [answersSheetOpen, setAnswersSheetOpen] = useState(false);

  // The server's "All" counts pending invites as well. They are listed on the Invitations card now, not below.
  const participantTotal: number | undefined = participantCounts
    ? participantCounts.total - (participantCounts.pendingInvites ?? 0)
    : undefined;
  // The people going (the server's rule: registered and not removed or left), apart from the host: the card's "Going".
  const goingIds: string[] = (participants || [])
    .filter((p: { userId: string; status: string }) => p.status !== 'removed' && p.status !== 'left' && p.userId !== session?.hostUserId)
    .map((p: { userId: string }) => p.userId);
  const isRegistered = (participants || []).some((p: any) => p.userId === user?.id && p.status !== 'removed');
  // T11 (1 Nov 2026), D11: what this viewer may do comes from the server (session.access), never from the pod.
  const access: EventAccess | undefined = session?.access;
  // Part 3 Task 8: the event cannot take this viewer now: it is full, or they are already on its waiting list.
  const cannotTakeMe = !!access?.waitlist && (access.waitlist.full || access.waitlist.position !== null);
  const [autoRegistering, setAutoRegistering] = useState(false);
  // Bug 13 (April 19) — block the auto-register useEffect after an EXPLICIT
  // unregister click. Without this, unregister → isRegistered flips false →
  // useEffect fires → re-registers automatically (the visible "flash" of
  // Register-then-back-to-Registered the user reported).
  const explicitlyUnregisteredRef = useRef(false);
  // T13 fix round 1: the event this page has already tried to register the member for, so it tries once.
  const autoRegisterTriedRef = useRef<string | null>(null);

  // Auto-register: if user landed here and isn't registered, register them immediately.
  // Shows loading state so "Register" button never flashes. Skipped after an
  // explicit unregister (see ref above).
  //
  // Failure handling: SESSION_ALREADY_REGISTERED is idempotent (fine, silent).
  // Anything else (private pod, event ended, etc.) gets a visible toast — we
  // used to swallow these errors which made the user think the auto-register
  // worked when it didn't, then the Register button appeared mysteriously.
  // Part 3 Task 10: a refusal for a group or a required answer opens "Before you join" instead of a toast.
  //
  // Final preview fix (11 Nov 2026): whether the page is about to register this member is one rule, read by the effect
  // and by Register, which shows it is working from the first frame until that registration has answered (and, when it
  // took, until the list reads Registered). Register used to stay pressable meanwhile: a press sent a second request,
  // the sheet the first refusal opened covered the button under the press, and the second refusal then said "Answer the
  // questions first." to someone who had not been asked anything yet.
  const autoRegisterDue = (): boolean => {
    if (explicitlyUnregisteredRef.current) return false;
    // An event that has ended or was cancelled takes nobody (the server refuses, and the refusal showed as an error
    // to anyone opening it who had not registered: a pod member reading the chat, someone following a link).
    if (phase === 'done' || phase === 'cancelled') return false;
    // T11 (L17): opening the page registers only the event's audience and its invitees. A server before T11 sends
    // no access block, and the page registers as it always did.
    if (access && !access.autoRegister) return false;
    // T13 fix round 1: at most one try per event, whatever answers next (a failure, a refetch of the list).
    if (autoRegisterTriedRef.current === sessionId) return false;
    return !!(session && user && participants && !isRegistered && sessionId);
  };
  const pageRegistering = autoRegistering || autoRegisterDue();
  useEffect(() => {
    if (autoRegistering || !autoRegisterDue()) return;
    autoRegisterTriedRef.current = sessionId ?? null;
    setAutoRegistering(true);
    // Register stays busy until the list it invalidates has been read again (it then says Registered).
    api.post(`/sessions/${sessionId}/register`).then(() => qc.invalidateQueries({ queryKey: ['session-participants', sessionId] }))
      .catch(err => {
        const code = err?.response?.data?.error?.code;
        if (code === 'SESSION_ALREADY_REGISTERED') return; // idempotent — silent
        if (code === 'SESSION_FULL') return void qc.invalidateQueries({ queryKey: ['session', sessionId] }); // Part 3: offers the line
        if (needsAnswers(err)) return void setAnswersSheetOpen(true);
        const msg = err?.response?.data?.error?.message;
        if (msg) addToast(msg, 'error');
      })
      .finally(() => setAutoRegistering(false));
    // T13 fix round 1: the participant list and the server's autoRegister are deps too. The event and the list load in
    // parallel, and when the list came second the effect never ran again, so a circle member (whose list read is a little
    // slower) was left looking at Register.
  }, [session?.id, user?.id, isRegistered, !!participants, access?.autoRegister, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEdit = () => setEditOpen(true);

  // Part 3 Task 8: one press at a time. A double press (or a double tap) sends one request, so it joins the line once;
  // the server would give the same number again anyway.
  const registerInFlight = useRef(false);
  const registerMutation = useMutation({
    // A full event (the server's access.waitlist.full) asks for the waiting list: 202 and the person's number. Part 3
    // Task 10: a retry from "Before you join" carries the group and the answers it gave (`choices`).
    mutationFn: (choices?: GivenAnswers) => api.post(`/sessions/${sessionId}/register`, registerBodyWith(registerBody(access), choices)),
    onSuccess: (res) => {
      setAnswersSheetOpen(false);
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      const position = waitlistedPosition(res);
      if (position !== null) addToast(WAITLIST_COPY.joinedToast(position), 'info');
      else addToast('Registered for event!', 'success');
    },
    onError: (err: any) => {
      const errCode = err?.response?.data?.error?.code;
      // A sheet left open over a page that is now Registered or full would be stale: these two answers close it.
      if (errCode === 'SESSION_ALREADY_REGISTERED' || errCode === 'SESSION_FULL') setAnswersSheetOpen(false);
      if (errCode === 'SESSION_ALREADY_REGISTERED') {
        addToast('You\'re already registered for this event!', 'info');
        qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
      } else if (errCode === 'SESSION_FULL') {
        // It filled while the page was open: read it again, and the page offers the waiting list.
        qc.invalidateQueries({ queryKey: ['session', sessionId] });
        addToast(err?.response?.data?.error?.message || WAITLIST_COPY.full, 'info');
      } else if (needsAnswers(err)) {
        // The event needs a group or an answer first: the sheet asks for it. Refused again with it open, it says why.
        if (answersSheetOpen) addToast(err?.response?.data?.error?.message || 'Answer the questions first.', 'error');
        setAnswersSheetOpen(true);
      } else {
        const msg = err?.response?.data?.error?.message || 'Failed to register';
        addToast(msg, 'error');
      }
    },
    onSettled: () => {
      registerInFlight.current = false;
    },
  });
  const register = () => {
    if (registerInFlight.current) return;
    registerInFlight.current = true;
    registerMutation.mutate(undefined);
  };
  // "Before you join" registers again with the group and answers it gave (one press at a time, as Register).
  const registerWithAnswers = (given: GivenAnswers): Promise<unknown> => {
    if (registerInFlight.current) return Promise.resolve();
    registerInFlight.current = true;
    return registerMutation.mutateAsync(given);
  };

  // The copy names its type (D9): sent as config only, the server read it from config.eventType, which a row from
  // before 26 Oct may name wrongly.
  const duplicateMutation = useMutation({
    mutationFn: () => api.post('/sessions', {
      podId: session?.podId,
      title: `${session?.title || 'Event'} (copy)`,
      description: session?.description || '',
      scheduledAt: null,
      // D9: the copy keeps who can join (a NULL visibility stays NULL: follow the pod) and the event's type.
      ...(session?.visibility ? { visibility: session.visibility } : {}),
      format: session ? resolveEventFormat(session) : undefined,
      config: session?.config,
      // Part 3: and its zone, so the copy's times read on the same clock (the image is not copied).
      timezone: session?.timezone,
      // T13: and the circle it is for (the server lets only the circle's managers name it).
      ...duplicateCircleField(session ?? {}),
    }),
    onSuccess: (res: any) => {
      const newId = res.data?.data?.id;
      addToast('Event duplicated! Edit the new event to set a date.', 'success');
      if (newId) navigate(`/sessions/${newId}`);
    },
    onError: (err: unknown) => addToast(circleErrorSentence(err, 'Failed to duplicate event'), 'error'),
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
    // T11 fix round 1: a private event says so (the server's code EVENT_PRIVATE); any other refusal reads as before.
    const isPrivateEvent = (sessionError as any)?.response?.data?.error?.code === 'EVENT_PRIVATE';
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
            {isPrivateEvent ? (
              <>
                <h1 data-testid="event-private-title" className="text-xl font-bold text-[#1a1a2e] mb-2">{ACCESS_COPY.privateTitle}</h1>
                <p data-testid="event-private-notice" className="text-gray-500 text-sm max-w-md">{ACCESS_COPY.privateWho}</p>
              </>
            ) : (
              <>
                <h1 className="text-xl font-bold text-[#1a1a2e] mb-2">Access restricted</h1>
                <p className="text-gray-500 text-sm max-w-md">
                  You don't have access to this event. Ask the host for an invite or join the pod to see details.
                </p>
              </>
            )}
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
  // 30 Oct 2026 — an in-person event has no video room: no Go Live, no Enter Event; its place instead.
  const hasRoom = liveKindOf(eventFormat) !== 'none';
  const place = eventPlace(eventFormat, session.config);
  const facts = eventFacts(eventFormat, session.config);
  // The people tile counts the attendee list, which a person still waiting cannot read.
  const tiles = facts.length + (waitingInLine ? 0 : 1);
  const groupsData = groupsView.data;
  // The people who run the event are not matched, so they have no group to change.
  const isCohostOrHost = (p: { userId: string; isCohost?: boolean }) => !!p.isCohost || p.userId === session.hostUserId;
  const showAfterEventTools = phase === 'done' && mayRunEvent;
  // The people who are matched (not the host or a co-host) read and change their own answers until the event is live.
  const showMyAnswers = !isHost && !viewerIsCohost && phase === 'pre' && (isRegistered || waitingInLine || access?.myRequest === 'pending');
  // The words of the press the sheet repeats: the same as the page's own Register button.
  const joinLabel = access?.waitlist?.full ? WAITLIST_COPY.join : session.status === 'scheduled' ? 'Register' : 'Join Late';
  // The matching board (Part 2 Task 13): the people the server lets plan a rounds event's meetings (canActAsHost: the
  // host, a co-host, the pod's director, a super admin), before it starts and while it runs.
  const mayPlanMeetings = isRoundsEvent && (phase === 'pre' || phase === 'live')
    && (isHost || viewerIsCohost || user?.role === 'super_admin' || pod?.memberRole === 'director');
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
        {/* Part 3: the event's image; its host and platform admins (the server's rule) add, change or remove it. */}
        <EventImageHeader sessionId={session.id} src={session.imageUrl} title={session.title || 'Event'} canChange={isHost || isAdmin} />
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-[#1a1a2e] [overflow-wrap:anywhere]">{session.title || 'Event'}</h1>
            {session.description && <p className="text-gray-500 mt-1 text-sm">{session.description}</p>}
            {/* T13: an event for a whole circle says so, and links the circle. */}
            {session.circle && (
              <Link to={`/circles/${session.circle.id}`} data-testid="event-circle" className="mt-1 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-rsn-red hover:underline [overflow-wrap:anywhere]">
                <CircleDashed className="h-4 w-4 shrink-0" /> {eventCircleLine(session.circle.name)}
              </Link>
            )}
            {/* On the event's own clock, its zone named, for everyone wherever they are (Part 3, K1). */}
            <p className="text-gray-500 mt-2 text-sm flex items-center gap-1.5" data-testid="event-when">
              <Calendar className="h-4 w-4 shrink-0" />
              {eventWhen(session.scheduledAt, session.timezone, 'long') ?? 'No date set'}
            </p>
            <p className="text-gray-500 mt-1 text-sm flex items-center gap-1.5">
              <Radio className="h-4 w-4 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {eventFactsLine(eventFormat, session.config, presetNameOf(session.config, presets))}
              </span>
            </p>
          </div>
          {/* Part 2 Task 11: the people running the event read where it stands (Draft … Cancelled); members as before. */}
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {mayRunEvent && isEventLifecycleChip(session.lifecycle) ? (
              <Badge variant={lifecycleColor(session.lifecycle)} className="shrink-0">{lifecycleLabel(session.lifecycle)}</Badge>
            ) : (
              <Badge variant={statusVariant} className="shrink-0">{sessionStatusLabel(session.status)}</Badge>
            )}
            {/* Part 3 Task 8: every place is taken. Attendees are told only this, never a count. */}
            {access?.waitlist?.full && (phase === 'pre' || phase === 'live') && (
              <span data-testid="event-full-chip">
                <Badge variant="warning" className="shrink-0">{WAITLIST_COPY.fullChip}</Badge>
              </span>
            )}
          </div>
        </div>
        {/* The place spans the card, under the title and the status, so a long address has room on a phone. */}
        {place && <EventPlace place={place} over={phase === 'done'} />}

        <div className={`grid ${tiles === 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'} gap-4 mt-4 pt-4 border-t border-gray-200`}>
          {!waitingInLine && (
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-gray-500 mb-1">
                <Users className="h-4 w-4" />
              </div>
              <p className="text-lg font-bold text-[#1a1a2e]">{(participants || []).length}</p>
              <p className="text-xs text-gray-400">{(participants || []).length === 1 ? 'participant' : 'participants'}</p>
            </div>
          )}
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
      {(session.status === 'lobby_open' || session.status === 'round_active' || session.status === 'round_rating' || session.status === 'round_transition') && !isRegistered && !cannotTakeMe && (
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

      {/* Actions: ONE bar for the event (11 Nov 2026, the owner's "???" over the gap). The primary actions first (Go Live,
          Join, Register or the waiting list, then Add to calendar), then the organiser's tools in the same row, every one
          left-aligned, 44px tall, one gap apart. Nothing is pushed to the right: on a phone they wrap line by line. */}
      <div data-testid="event-actions" className="flex flex-wrap items-center gap-3 animate-fade-in-up stagger-1">
        {/* Non-host participant flows: Register / Join Late / Pending-invite notice */}
        {!isHost && sessionStatusPhase(session.status) !== 'done' && sessionStatusPhase(session.status) !== 'cancelled' && !isRegistered && (
          <EventAccessActions
            sessionId={sessionId!}
            access={access}
            registerLabel={session.status === 'scheduled' ? 'Register' : 'Join Late'}
            onRegister={register}
            registering={registerMutation.isPending || pageRegistering}
            circleName={session.circle?.name}
          />
        )}
        {!isHost && isRegistered && sessionStatusPhase(session.status) === 'live' && (
          <div data-testid="event-registered" className="flex min-h-[44px] items-center gap-2 px-4 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
            <CheckCircle className="h-4 w-4" /> Registered
          </div>
        )}
        {!isHost && isRegistered && sessionStatusPhase(session.status) === 'pre' && (
          <>
            <div data-testid="event-registered" className="flex min-h-[44px] items-center gap-2 px-4 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
              <CheckCircle className="h-4 w-4" /> Registered
            </div>
            <Button variant="ghost" onClick={async () => {
              if (!(await ask({ title: 'Unregister from this event?', body: 'To come back you register again, or ask for a new invite.', confirmLabel: 'Unregister', tone: 'danger' }))) return;
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
        {hasRoom && (isRegistered || isHost) && sessionStatusPhase(session.status) === 'pre' && !isDraft && (
          <Button
            variant="primary"
            onClick={() => navigate(`/session/${sessionId}/live`)}
            className="btn-glow"
          >
            <Play className="h-4 w-4 mr-2" />
            {isHost ? 'Go Live' : 'Enter Event'}
          </Button>
        )}
        {hasRoom && (isRegistered || isHost) && sessionStatusPhase(session.status) === 'live' && (
          <Button
            variant="primary"
            onClick={() => navigate(`/session/${sessionId}/live`)}
            className="btn-glow"
          >
            <Play className="h-4 w-4 mr-2" /> Enter Live Event
          </Button>
        )}
        {/* A scheduled event in any calendar: Google, Outlook.com or a file this page builds (1 Nov 2026, T7). An
            in-person event carries its place as where it is (30 Oct 2026, T12). The
            entry links back to this page on this site. */}
        {session.status === 'scheduled' && session.scheduledAt && !isDraft && (
          <AddToCalendar
            entry={eventEntry({
              title: session.title || 'Event',
              startAt: session.scheduledAt,
              durationMin: eventDurationMinutes(eventFormat, session.config),
              pageUrl: `${window.location.origin}/sessions/${session.id}`,
              place,
            })}
            file={async () => icsFile(eventEntry({
              title: session.title || 'Event',
              startAt: session.scheduledAt,
              durationMin: eventDurationMinutes(eventFormat, session.config),
              pageUrl: `${window.location.origin}/sessions/${session.id}`,
              place,
            }), `event-${session.id}`)}
            fileName="reason-event.ics"
            className="min-h-[44px] px-4 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 inline-flex items-center gap-2 text-sm font-semibold text-[#1a1a2e] transition-colors"
          />
        )}
        {phase === 'done' && (
          <Button variant="primary" className="btn-glow" onClick={openRecap}>
            {isRoundsEvent ? 'View recap' : 'Who took part'}
          </Button>
        )}

        {/* The organiser's tools, in the same row after the primary actions. Host Controls button intentionally
            removed: live host controls live inside the /live page once the host clicks Enter Live Event.
            Co-hosts send invites too (26 Oct 2026), so they get the invite button and nothing else here. */}
        {(isHost || isAdmin || mayInvite || mayPlanMeetings) && sessionStatusPhase(session.status) !== 'cancelled' && (
          <>
            {mayPlanMeetings && (
              <Link
                to={`/sessions/${sessionId}/board`}
                data-testid="matching-board-link"
                className="min-h-[44px] px-4 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 flex items-center gap-2 text-sm font-semibold text-[#1a1a2e] transition-colors"
              >
                <LayoutGrid className="h-4 w-4" /> Matching board
              </Link>
            )}
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
                {/* Part 2 Task 11: no legacy Delete here. Cancel event (with a notice to everyone registered), Archive and
                    Delete permanently are in the Event status card below, as the server's allowedActions say. */}
              </>
            )}
            {/* End event last among the tools (the owner's order: Matching board, Invite people, Copy, Edit, End event). */}
            {mayEndForEveryone && sessionId && <EndEventButton sessionId={sessionId} />}
          </>
        )}
      </div>

      {/* Part 3 Task 10: "Your answers", for someone with a place, a request or a number in the line, before the event. */}
      {showMyAnswers && sessionId && <MyAnswersRow sessionId={sessionId} view={questionsView.data} />}

      {/* Part 2 Task 11: the organiser's settings: status and lifecycle steps, the call link, admission, groups. */}
      {sessionId && (
        <OrganiserSettings
          event={{ ...session, id: sessionId }}
          phase={phase}
          mayRunEvent={mayRunEvent}
          isRoundsEvent={isRoundsEvent}
          mayChooseOverride={isHost || user?.role === 'super_admin'}
          groups={groupsView}
        />
      )}

      {/* After the event, for the people who run it: message everyone who took part, or start a group chat with them. */}
      {showAfterEventTools && sessionId && (
        <div data-testid="after-event-tools" className="grid gap-3 empty:hidden animate-fade-in-up stagger-1">
          <MessageParticipantsPanel sessionId={sessionId} />
          <StartGroupChatCard sessionId={sessionId} />
        </div>
      )}

      {/* The event report (Part 3 Task 9): the figures, the three spreadsheets and the full report, for the same people.
          It draws nothing for anyone the server refuses. */}
      {showAfterEventTools && sessionId && (
        <div className="animate-fade-in-up stagger-1">
          <EventReportCard sessionId={sessionId} />
        </div>
      )}

      {/* The event's chat: kept with it once it has ended; inside the live event while it runs. */}
      {sessionId && (phase === 'done' || phase === 'live') && !waitingInLine && (
        <div className="animate-fade-in-up stagger-2">
          <EventChatHistory sessionId={sessionId} live={phase === 'live'} canEnterLive={isRegistered || isHost} />
        </div>
      )}

      {/* Who is invited and who declined, for the people who run the event, while it can still take people. It
          replaces the "Pending Invites" chip and the grey rows that sat at the end of the participants. */}
      {/* T11: the people who run an event that asks for approval answer its requests here (the bell opens ?requests=1). */}
      {access?.canManageRequests && access.visibility === 'public_with_approval' && (phase === 'pre' || phase === 'live') && sessionId && (
        <EventJoinRequestsCard sessionId={sessionId} focus={searchParams.get('requests') === '1'} />
      )}

      {/* Part 3 Task 8: a full event's waiting list, for the people who run it (the card draws nothing for anyone the
          server refuses, and nothing while the event has room and nobody waits). */}
      {mayRunEvent && (phase === 'pre' || phase === 'live') && sessionId && (
        <WaitlistCard sessionId={sessionId} full={!!access?.waitlist?.full} />
      )}

      {mayInvite && sessionId && (
        <InviteStatusList
          target={{ type: 'session', sessionId, podId: session.podId ?? null }}
          present={goingIds}
          presentCount={goingIds.length}
          onInvite={() => setInviteOpen(true)}
        />
      )}

      {/* Part 3 Task 8: someone still waiting reads who is coming once a place is theirs. */}
      {waitingInLine && (
        <Card data-testid="waitlist-people-later" className="animate-fade-in-up stagger-2">
          <p className="text-gray-500 text-sm text-center py-2">{WAITLIST_COPY.peopleLater}</p>
        </Card>
      )}

      {/* Participants */}
      {!waitingInLine && (
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
                    <Link to={personHref(hostRow.userId, 'Events')} className="flex min-h-[44px] items-center gap-3 hover:opacity-80 transition-opacity">
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
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <Link to={personHref(p.userId || p.id, 'Events')} className="flex min-h-[44px] items-center gap-3 hover:opacity-80 transition-opacity min-w-0">
                      <Avatar src={p.avatarUrl} name={p.displayName || p.email || 'User'} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{p.displayName || p.email || 'Participant'}</p>
                        <p className="text-xs text-gray-400">{p.isCohost ? 'Co-Host' : statusLabel}</p>
                      </div>
                    </Link>
                    {/* S16 — pre-event co-host management on the event page.
                        Same semantics as the live drawer's shield toggle. */}
                    <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                      {/* Part 2 Task 11: the person's matching group, and Change group before the event (organisers). */}
                      {sessionId && groupsData && groupsData.groups.length > 0 && groupsData.members && p.userId && (
                        <ParticipantGroupControl
                          sessionId={sessionId}
                          userId={p.userId}
                          name={p.displayName || 'This person'}
                          groups={groupsData.groups}
                          mine={groupsData.members[p.userId] ?? []}
                          allowMultiple={groupsData.allowMultiple}
                          canChange={phase === 'pre' && !isCohostOrHost(p)}
                        />
                      )}
                      {/* Part 3 Task 10: their answers to the extra matching questions (organisers only: nobody else reads them). */}
                      {p.userId && <AnswerChips view={questionsView.data} userId={p.userId} />}
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
      )}

      {/* Part 2 Task 11: who did what to this event, for the people running it (the server refuses anyone else). */}
      {mayRunEvent && sessionId && <EventHistoryPanel sessionId={sessionId} />}

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

      {/* Part 3 Task 10: "Before you join": the group and the extra matching questions, then Register again with them. */}
      {sessionId && (
        <MyEventAnswersSheet
          sessionId={sessionId}
          open={answersSheetOpen}
          onClose={() => setAnswersSheetOpen(false)}
          mode="join"
          submitLabel={joinLabel}
          busy={registerMutation.isPending}
          onJoin={registerWithAnswers}
        />
      )}

      {/* Edit Event: the same type picker and settings as Schedule an Event */}
      <EditEventModal open={editOpen} onClose={() => setEditOpen(false)} session={session} podType={pod?.podType} podVisibility={pod?.visibility} podName={pod?.name} isAdmin={isAdmin} />
      {confirmDialog}
    </div>
  );
}
