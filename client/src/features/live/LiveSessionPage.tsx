import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import useSessionSocket from '@/hooks/useSessionSocket';
import Lobby from './Lobby';
import VideoRoom from './VideoRoom';
import RatingPrompt from './RatingPrompt';
import SessionComplete from './SessionComplete';
import HostControls from './HostControls';
import ChatPanel from './ChatPanel';
import MatchingOverlay from './MatchingOverlay';
import ReactionBar from './ReactionBar';
import ParticipantList from './ParticipantList';
import { SectionErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoader } from '@/components/ui/Spinner';
import { AlertCircle, X, LogOut, WifiOff, Loader2, RefreshCw, MessageCircle, Radio, Users, Shuffle, Mic, ArrowLeftRight, CheckCircle2 } from 'lucide-react';
import api from '@/lib/api';
import { disconnectSocket, connectSocket, getSocket } from '@/lib/socket';

export default function LiveSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const phase = useSessionStore(s => s.phase);
  const broadcasts = useSessionStore(s => s.broadcasts);
  const sessionError = useSessionStore(s => s.error);
  const connectionStatus = useSessionStore(s => s.connectionStatus);
  const transitionStatus = useSessionStore(s => s.transitionStatus);
  const isPaused = useSessionStore(s => s.isPaused);
  const sessionStatus = useSessionStore(s => s.sessionStatus);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const chatOpen = useSessionStore(s => s.chatOpen);
  const unreadChatCount = useSessionStore(s => s.unreadChatCount);
  const matchingOverlay = useSessionStore(s => s.matchingOverlay);
  const { setError, setPhase, reset, setChatOpen } = useSessionStore.getState();
  const { user } = useAuthStore();
  const mediaRequestedRef = useRef(false);
  const [participantListOpen, setParticipantListOpen] = useState(false);

  const [mediaError, setMediaError] = useState(false);

  // Request media permissions once per event entry (not per room transition)
  useEffect(() => {
    if (mediaRequestedRef.current) return;
    mediaRequestedRef.current = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError(true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop());
      })
      .catch(() => {
        setMediaError(true);
      });
  }, []);

  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then(r => r.data.data),
    enabled: !!sessionId,
  });

  const cohosts = useSessionStore(s => s.cohosts);
  const actingAsHostOverrides = useSessionStore(s => s.actingAsHostOverrides);
  const isOriginalHost = session?.hostUserId === user?.id;
  const isCohost = !!user?.id && cohosts.has(user.id);
  // Phase I (10 May spec item 18 — refined) — only super_admin auto-sees
  // host UI when joining as a participant. Regular admins join as normal
  // participants; they can be promoted to cohost by the host or super
  // admin if intervention is needed. Matches the new server-side
  // canActAsHost gate (effective-role.service.ts:67) which also narrowed
  // from admin+ to super_admin only.
  const isSuperAdmin = user?.role === 'super_admin';
  // Phase L (12 May item 6) canonical base form — single disjunction of
  // the three role-derived states that grant host UI. Kept as a named
  // binding so the Phase L role-consistency pin stays valid AND so
  // Phase M's override layer composes against a stable base value.
  const baseIsHost = isOriginalHost || isCohost || isSuperAdmin;
  // Phase M (12 May item 1) — per-event acting-as-host override. The
  // current user's own override (if any) trumps the base role gate:
  // FALSE means they explicitly chose to attend as a participant; TRUE
  // means they explicitly opted in to host. Undefined / null = follow
  // baseIsHost. Server's getEffectiveRole applies the same precedence.
  const myActingAsHost: boolean | undefined =
    user?.id ? actingAsHostOverrides[user.id] : undefined;
  const isHost =
    myActingAsHost === false
      ? false
      : myActingAsHost === true
      ? true
      : baseIsHost;

  // Phase P (Ali's 13 May clarification) — eligibility for the "Join as
  // host" / "Join as participant" toggle. Admins (Shraddha, Raja Ali) and
  // super_admins (Stefan) get the toggle ONLY when they did NOT create
  // the event. The event director is permanently the host of their own
  // event. `isDirector` is the same identity check the server uses.
  const isDirector = !!user?.id && session?.hostUserId === user?.id;
  const isAdminOrSuperAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const canToggleActingAsHost = isAdminOrSuperAdmin && !isDirector;
  // Pre-event banner condition: eligible user, has not explicitly chosen
  // yet for THIS event. Banner stays visible until they pick — it's a
  // nudge, not a dismissable toast.
  const showJoinAsBanner =
    canToggleActingAsHost && myActingAsHost === undefined;

  useSessionSocket(sessionId!);

  // If session is already completed (e.g. page refresh), show complete phase
  useEffect(() => {
    if (session?.status === 'completed') {
      setPhase('complete');
    }
  }, [session?.status, setPhase]);

  const handleLeave = () => {
    const inActivePhase = phase === 'matched' || phase === 'rating';
    const message = inActivePhase
      ? 'You\'re in a breakout room. Leaving will end your conversation. Leave event?'
      : 'Leave this event?';
    if (!confirm(message)) return;
    getSocket()?.emit('session:leave', { sessionId: sessionId! });
    disconnectSocket();
    reset();
    navigate('/sessions');
  };

  if (!sessionId) return <PageLoader />;

  return (
    // Phase 7-audit fix — overflow-x-hidden on the root prevents any
    // child overflow (host bar, event plan strip) from forcing the
    // viewport wider on mobile. min-w-0 lets flex children shrink
    // below their content width instead of pushing the parent.
    <div className="h-[100dvh] bg-white flex flex-col overflow-x-hidden min-w-0">
      {/* Phase 5B (5 May spec) — test-mode banner.
          Shown to ALL participants when the server detects multiple
          accounts sharing the host's email-username root, OR when the
          host explicitly set session.config.testMode=true. Stefan #2:
          "clearly separate test mode vs real users". */}
      <TestModeBanner />
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200">
        <div className="flex items-center gap-1.5 min-w-0">
          {session?.podId && session?.podName && (
            <span className="text-xs text-gray-400 shrink-0">
              <a href={`/pods/${session.podId}`} className="hover:text-gray-600 transition-colors">{session.podName}</a>
              <span className="mx-1">/</span>
            </span>
          )}
          <h2 className="text-sm font-medium text-[#1a1a2e] truncate">{session?.title || 'Live Event'}</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setParticipantListOpen(!participantListOpen)}
            className={`p-2 rounded-full transition-colors ${participantListOpen ? 'bg-gray-200 text-[#1a1a2e]' : 'text-gray-500 hover:text-[#1a1a2e] hover:bg-gray-100'}`}
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            onClick={handleLeave}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-500 transition-colors px-3 py-1.5 rounded-full hover:bg-gray-100"
          >
            <LogOut className="h-4 w-4" /> Leave
          </button>
        </div>
      </div>

      {/* Persistent event state banner — hidden during breakout/rating (they have own UI) */}
      {connectionStatus === 'connected' && phase !== 'matched' && phase !== 'rating' && (
        <EventStateBanner sessionStatus={sessionStatus} currentRound={currentRound} totalRounds={totalRounds} phase={phase} />
      )}

      {/* Broadcast banner */}
      {broadcasts.length > 0 && (
        <div className="bg-rsn-red px-4 py-2 text-center">
          <p className="text-sm font-medium text-white"><LinkifyText text={broadcasts[broadcasts.length - 1]} /></p>
        </div>
      )}

      {/* Connection status banner */}
      {connectionStatus === 'connecting' && (
        <div className="bg-gray-100 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
          <p className="text-sm text-gray-400">Joining...</p>
        </div>
      )}
      {connectionStatus === 'reconnecting' && (
        <div className="bg-amber-500/10 px-4 py-2 flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-400">Reconnecting...</p>
        </div>
      )}
      {connectionStatus === 'disconnected' && (
        <div className="bg-red-500/10 px-4 py-2 flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4 text-red-400" />
          <p className="text-sm text-red-400">
            {transitionStatus === 'evicted'
              ? 'You connected from another device or tab'
              : 'You\'ve been disconnected'}
          </p>
          <button
            onClick={() => { if (transitionStatus === 'evicted') { window.location.reload(); } else { connectSocket(); } }}
            className="ml-2 flex items-center gap-1 text-sm text-red-400 hover:text-red-300 underline"
          >
            <RefreshCw className="h-3 w-3" /> {transitionStatus === 'evicted' ? 'Rejoin here' : 'Rejoin'}
          </button>
        </div>
      )}

      {/* Pause banner — visible to all participants */}
      {isPaused && (
        <div className="bg-amber-500/15 px-4 py-2 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-400 font-medium">Round paused by host</p>
        </div>
      )}

      {/* Phase P (Ali's 13 May clarification) — pre-event "Join as" banner
          for non-director admin/super_admin users who haven't chosen yet.
          Two prominent buttons; the banner stays visible until they pick
          so it's their explicit decision, not an auto-default. */}
      {showJoinAsBanner && (
        <div
          data-testid="join-as-banner"
          className="bg-indigo-50 border-b border-indigo-200 px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        >
          <p className="text-sm text-indigo-900">
            You're a {user?.role === 'super_admin' ? 'super admin' : 'admin'} and not the director of this event.
            How are you joining?
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                try {
                  await api.post(`/sessions/${sessionId}/host/acting-as-host`, { value: true });
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error('host:set_acting_as_host (opt-in) failed', err);
                }
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-indigo-300 bg-white text-indigo-900 hover:bg-indigo-100 font-medium"
              data-testid="join-as-banner-host"
            >
              Join as host
            </button>
            <button
              onClick={async () => {
                try {
                  await api.post(`/sessions/${sessionId}/host/acting-as-host`, { value: false });
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error('host:set_acting_as_host (opt-out) failed', err);
                }
              }}
              className="text-xs px-3 py-1.5 rounded-md border border-indigo-300 bg-white text-indigo-900 hover:bg-indigo-100 font-medium"
              data-testid="join-as-banner-participant"
            >
              Join as participant
            </button>
          </div>
        </div>
      )}

      {/* Phase M (12 May item 1) — "Switch back to host" banner.
          Visible only to users who have base host capability (super_admin /
          event host / cohost) but have explicitly opted out for this event.
          Without this banner, opting out via HCC would hide the Control
          Center and leave the user with no path back to host UI. */}
      {baseIsHost && myActingAsHost === false && (
        <div
          data-testid="acting-as-host-revert-banner"
          className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between gap-3"
        >
          <p className="text-sm text-amber-800">
            You're attending this event as a participant. Host controls hidden.
          </p>
          <button
            onClick={async () => {
              try {
                await api.post(`/sessions/${sessionId}/host/acting-as-host`, { value: null });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('host:set_acting_as_host revert failed', err);
              }
            }}
            className="text-xs px-2.5 py-1 rounded-md border border-amber-300 text-amber-800 hover:bg-amber-100"
          >
            Switch back to host
          </button>
        </div>
      )}

      {/* Transition status: "Wrapping up..." banner removed (April 17 screenshot).
          Host Controls already surface end-of-event state; no need for a second blocking banner. */}

      {/* Error banner — dismissable */}
      {mediaError && (
        <div className="bg-amber-500/15 px-4 py-2 flex items-center justify-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-300">Camera/microphone access denied. Check browser permissions to enable video.</p>
          <button onClick={() => setMediaError(false)} className="ml-2 text-amber-400 hover:text-amber-300">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {sessionError && (
        <div className="bg-red-500/15 px-4 py-2 flex items-center justify-center gap-2">
          <AlertCircle className="h-4 w-4 text-red-400" />
          <p className="text-sm text-red-400">{sessionError}</p>
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-300">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Matching confirmed overlay — full screen for participants, banner for host */}
      {matchingOverlay && !isHost && (
        <MatchingOverlay roomCount={matchingOverlay.roomCount} roundNumber={currentRound} />
      )}
      {matchingOverlay && isHost && (
        <div className="bg-emerald-500/15 px-4 py-2 flex items-center justify-center gap-2 animate-fade-in">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <p className="text-sm text-emerald-600 font-medium">
            Matches confirmed — {matchingOverlay.roomCount} room{matchingOverlay.roomCount !== 1 ? 's' : ''} ready. Click Start Round when ready.
          </p>
        </div>
      )}

      {/* Main content + chat panel layout */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Session content */}
        <div className={`flex-1 flex flex-col overflow-hidden ${chatOpen ? 'hidden sm:flex' : ''}`}>
          {phase === 'lobby' && <SectionErrorBoundary name="Lobby"><Lobby isHost={isHost} sessionId={sessionId} /></SectionErrorBoundary>}
          {phase === 'matched' && <SectionErrorBoundary name="Video"><VideoRoom isHost={isHost} /></SectionErrorBoundary>}
          {phase === 'rating' && <SectionErrorBoundary name="Rating"><RatingPrompt sessionId={sessionId} /></SectionErrorBoundary>}
          {phase === 'complete' && <SessionComplete sessionId={sessionId} />}
        </div>

        {/* Participant list panel */}
        {participantListOpen && !chatOpen && (
          <div className="w-full sm:w-72 sm:min-w-[288px] flex-shrink-0 h-full border-l border-white/10">
            <ParticipantList onClose={() => setParticipantListOpen(false)} sessionId={sessionId} />
          </div>
        )}

        {/* Chat panel -- side panel on desktop, full overlay on mobile */}
        {chatOpen && (
          <div className="w-full sm:w-80 sm:min-w-[320px] flex-shrink-0 h-full">
            <SectionErrorBoundary name="Chat"><ChatPanel sessionId={sessionId} onClose={() => setChatOpen(false)} /></SectionErrorBoundary>
          </div>
        )}

        {/* Reaction bar — toggleable, bottom-left */}
        {phase !== 'complete' && phase !== 'rating' && sessionId && (
          <ReactionBar sessionId={sessionId} />
        )}

        {/* Chat toggle button. Phase C2 (10 May spec) — bottom offset accounts
            for iOS safe-area inset so the button never sits underneath the
            home-indicator bar on iPhone. min-h/min-w 44px = WCAG tap target. */}
        {!chatOpen && phase !== 'complete' && (
          <button
            onClick={() => setChatOpen(true)}
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 5rem)' }}
            className="absolute right-4 z-20 min-w-[44px] min-h-[44px] p-3 bg-[#3c4043] text-white rounded-full shadow-lg hover:bg-[#4a4e51] transition-all flex items-center justify-center"
            aria-label="Open chat"
          >
            <MessageCircle className="h-5 w-5" />
            {unreadChatCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[20px] h-5 flex items-center justify-center bg-blue-500 text-white text-[11px] font-bold rounded-full px-1">
                {unreadChatCount > 9 ? '9+' : unreadChatCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Host controls visible in all active phases */}
      {isHost && phase !== 'complete' && <HostControls sessionId={sessionId} />}
    </div>
  );
}

/* ─── Persistent Event State Banner ─────────────────────────────────────── */

const STATE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  scheduled:        { label: 'Waiting to start', icon: <Users className="h-3.5 w-3.5" />, color: 'bg-white/5 text-gray-400' },
  lobby_open:       { label: 'Main Room', icon: <Mic className="h-3.5 w-3.5" />, color: 'bg-white/5 text-gray-300' },
  round_active:     { label: 'Breakout Rooms · Round {round}', icon: <Radio className="h-3.5 w-3.5 animate-pulse" />, color: 'bg-red-500/10 text-red-400' },
  round_rating:     { label: 'Rating', icon: <ArrowLeftRight className="h-3.5 w-3.5" />, color: 'bg-amber-500/10 text-amber-400' },
  round_transition: { label: 'Main Room', icon: <Shuffle className="h-3.5 w-3.5" />, color: 'bg-white/5 text-gray-300' },
  // closing_lobby: empty label — the separate "Round X of Y" suffix carries the context on its own.
  closing_lobby:    { label: '', icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, color: 'bg-white/5 text-gray-400' },
  completed:        { label: 'Event ended', icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: 'bg-emerald-500/10 text-emerald-400' },
};

// Phase 5B (5 May spec) — test-mode banner. Renders only when
// store.testMode is true (server-detected or explicitly configured).
// Stefan #2: clearly separate test mode from real events so anyone
// looking at the screen knows this isn't production data.
function TestModeBanner() {
  const testMode = useSessionStore(s => s.testMode);
  if (!testMode) return null;
  return (
    <div className="px-4 py-1.5 flex items-center justify-center gap-2 text-xs font-semibold bg-amber-100 text-amber-900 border-b border-amber-300">
      <span aria-hidden="true">⚠</span>
      <span>Test mode — multiple accounts detected. This is not a real event.</span>
    </div>
  );
}

function EventStateBanner({ sessionStatus, currentRound, totalRounds }: { sessionStatus: string; currentRound: number; totalRounds: number; phase?: string }) {
  const config = STATE_CONFIG[sessionStatus] || STATE_CONFIG.scheduled;
  const label = config.label.replace('{round}', String(currentRound || 1));
  const roundInfo = totalRounds > 0 && sessionStatus !== 'completed' && sessionStatus !== 'scheduled'
    ? `Round ${currentRound || 1} of ${totalRounds}`
    : '';

  // Don't duplicate round info if already in label
  const showRoundInfo = roundInfo && !label.includes(`Round ${currentRound || 1}`);
  // Handle empty labels (e.g. closing_lobby) — show round info alone, no separator
  const display = label && showRoundInfo
    ? `${label} · ${roundInfo}`
    : label || (showRoundInfo ? roundInfo : '');

  return (
    <div className={`px-4 py-1.5 flex items-center justify-center gap-2 text-xs font-medium ${config.color}`}>
      {config.icon}
      <span>{display}</span>
    </div>
  );
}

/* ─── Linkify helper for broadcast banner ───────────────────────────────── */

const LINK_REGEX = /(https?:\/\/[^\s<]+)/g;

function LinkifyText({ text }: { text: string }) {
  const parts = text.split(LINK_REGEX);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline hover:opacity-80 break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
