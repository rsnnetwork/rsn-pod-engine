import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
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
import { AlertCircle, X, LogOut, WifiOff, Loader2, RefreshCw, MessageCircle, Radio, Users, Shuffle, Mic, ArrowLeftRight, CheckCircle2, Lock } from 'lucide-react';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
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
  const bonusRoundsAdded = useSessionStore(s => s.bonusRoundsAdded);
  const chatOpen = useSessionStore(s => s.chatOpen);
  const unreadChatCount = useSessionStore(s => s.unreadChatCount);
  const matchingOverlay = useSessionStore(s => s.matchingOverlay);
  const { setError, setPhase, reset, setChatOpen } = useSessionStore.getState();
  const { user } = useAuthStore();
  const addToast = useToastStore((s) => s.addToast);
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
    meta: { entities: sessionId ? [E.session(sessionId)] : [] },
  });

  const cohosts = useSessionStore(s => s.cohosts);
  const actingAsHostOverrides = useSessionStore(s => s.actingAsHostOverrides);
  // Bug I (15 May Ali) — wait for the session-state snapshot to land
  // before showing any role-gated banner. Without this the page shows
  // the "Join as host / participant" banner for a single frame on
  // refresh even if the admin already opted in, because the store starts
  // with actingAsHostOverrides={} until applyFullState fires.
  const sessionStateLoaded = useSessionStore(s => s.sessionStateLoaded);
  const isOriginalHost = session?.hostUserId === user?.id;
  const isCohost = !!user?.id && cohosts.has(user.id);
  // Bug D (15 May Ali) — super_admins no longer auto-default to host.
  // Pre-fix they saw Start/End Event buttons and host controls the moment
  // they opened the page, but the server-side hostsSet only counted them
  // as host once they explicitly opted in via the "Join as host" banner.
  // The mismatch produced screens where the count said "1 host" while a
  // super_admin had host controls — confusing for everyone in the lobby.
  // Now baseIsHost only reflects FORMAL roles (director + session_cohosts);
  // super_admin and admin both pass through Phase M (explicit pick + per-
  // event override) just like everyone else with the toggle.
  const baseIsHost = isOriginalHost || isCohost;
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
  // nudge, not a dismissable toast. Bug I (15 May Ali) — also gate on
  // sessionStateLoaded so the banner doesn't flash on refresh while the
  // snapshot is in-flight (Raja saw the toggle re-appear for a frame
  // after every refresh even though he'd already chosen).
  const showJoinAsBanner =
    canToggleActingAsHost && myActingAsHost === undefined && sessionStateLoaded;
  // Bug D (15 May Ali) — when a toggle-eligible user hasn't picked yet,
  // BLOCK the content area entirely. The banner stays at the top, the
  // header stays, but the lobby / video / rating / complete views and the
  // side panels all hide until they choose. Pre-fix the lobby rendered
  // immediately and admins saw host controls implicitly, which felt like
  // "auto-promoted" even though the count didn't agree. Bug I — also
  // gate on sessionStateLoaded so the blocker doesn't briefly cover the
  // page right after refresh for someone who already picked.
  const mustPickRole =
    canToggleActingAsHost && myActingAsHost === undefined && sessionStateLoaded;

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
        {/* Bug 10 (13 May live test) — once the event ends, the top-bar
            participant + leave controls must vanish along with chat /
            reactions / host controls. The recap page below has its own
            navigation; keeping the event controls visible after the
            event ended confuses users into thinking the event is still
            running. */}
        {phase !== 'complete' && (
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
        )}
      </div>

      {/* Persistent event state banner — hidden during breakout/rating (they have own UI) */}
      {connectionStatus === 'connected' && phase !== 'matched' && phase !== 'rating' && (
        <EventStateBanner sessionStatus={sessionStatus} currentRound={currentRound} totalRounds={totalRounds} bonusRoundsAdded={bonusRoundsAdded} phase={phase} />
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
          so it's their explicit decision, not an auto-default.
          Bug 16 (13 May live test) — also hidden on phase=complete so the
          recap page is the only thing on screen after the host ends. */}
      {showJoinAsBanner && phase !== 'complete' && (
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
                } catch {
                  addToast("Couldn't join as host. Try again.", 'error');
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
                } catch {
                  addToast("Couldn't join as participant. Try again.", 'error');
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

      {/* Persistent acting-as-host toggle banner.
          Bug D (15 May Ali) — toggle stays visible throughout the event
          so the admin/super_admin can switch direction at any time. Two
          variants, both gated on phase !== 'complete' (recap is the only
          thing on screen post-event) and on a non-empty pick (undefined
          → showJoinAsBanner above handles that path).
            • opted out (myActingAsHost === false) → "Switch back to host"
            • opted in  (myActingAsHost === true)  → "Switch to participant"
          Mid-breakout (matched / rating) the button stays visible but is
          disabled — switching mid-round would either drag a host into an
          in-progress breakout or pull a participant out of one.
          The "Switch back to host" path also covers formal cohosts who
          opted out (baseIsHost via isCohost + myActingAsHost === false). */}
      {phase !== 'complete' && (canToggleActingAsHost || baseIsHost) && myActingAsHost === false && (() => {
        const inBreakout = phase === 'matched' || phase === 'rating';
        return (
          <div
            data-testid="acting-as-host-revert-banner"
            className={`border-b px-4 py-2 flex items-center justify-between gap-3 ${inBreakout ? 'bg-amber-100/80 border-amber-300' : 'bg-amber-50 border-amber-200'}`}
          >
            <p className="text-sm text-amber-900 flex items-center gap-1.5">
              {/* Bug 14 (18 May Stefan) — when the role switch is blocked
                  by an active breakout, prefix the text with a lock icon
                  and a stronger background so the constraint reads at a
                  glance instead of looking like a generic info banner. */}
              {inBreakout && <Lock className="h-3.5 w-3.5 text-amber-700 shrink-0" aria-hidden="true" />}
              {inBreakout
                ? <span><span className="font-semibold">Role switch locked during breakout.</span> You're attending this event as a participant — switch back to host once the round ends.</span>
                : "You're attending this event as a participant. Host controls hidden."}
            </p>
            <button
              disabled={inBreakout}
              title={inBreakout ? 'Locked — wait for the breakout to end' : undefined}
              onClick={async () => {
                if (inBreakout) return;
                try {
                  await api.post(`/sessions/${sessionId}/host/acting-as-host`, { value: true });
                } catch {
                  addToast("Couldn't switch back to host. Try again.", 'error');
                }
              }}
              className={`text-xs px-2.5 py-1 rounded-md border ${inBreakout ? 'border-amber-300 text-amber-400 cursor-not-allowed bg-white/50' : 'border-amber-300 text-amber-800 hover:bg-amber-100'}`}
            >
              Switch back to host
            </button>
          </div>
        );
      })()}
      {/* Bug D (15 May Ali) — mirror banner for users currently acting as
          host so they can flip back to participant. Persists throughout
          the event; same in-breakout disable so they can't drop host role
          mid-round and orphan the breakout. */}
      {phase !== 'complete' && canToggleActingAsHost && myActingAsHost === true && (() => {
        const inBreakout = phase === 'matched' || phase === 'rating';
        return (
          <div
            data-testid="acting-as-participant-banner"
            className={`border-b px-4 py-2 flex items-center justify-between gap-3 ${inBreakout ? 'bg-indigo-100/80 border-indigo-300' : 'bg-indigo-50 border-indigo-200'}`}
          >
            <p className="text-sm text-indigo-900 flex items-center gap-1.5">
              {/* Bug 14 (18 May Stefan) — explicit locked-state when an
                  active breakout blocks the switch. */}
              {inBreakout && <Lock className="h-3.5 w-3.5 text-indigo-700 shrink-0" aria-hidden="true" />}
              {inBreakout
                ? <span><span className="font-semibold">Role switch locked during breakout.</span> You're attending this event as a host — switch to participant once the round ends.</span>
                : "You're attending this event as a host. Host controls visible."}
            </p>
            <button
              disabled={inBreakout}
              title={inBreakout ? 'Locked — wait for the breakout to end' : undefined}
              onClick={async () => {
                if (inBreakout) return;
                try {
                  await api.post(`/sessions/${sessionId}/host/acting-as-host`, { value: false });
                } catch {
                  addToast("Couldn't switch to participant. Try again.", 'error');
                }
              }}
              className={`text-xs px-2.5 py-1 rounded-md border ${inBreakout ? 'border-indigo-300 text-indigo-400 cursor-not-allowed bg-white/50' : 'border-indigo-300 text-indigo-800 hover:bg-indigo-100'}`}
            >
              Switch to participant
            </button>
          </div>
        );
      })()}

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
      {/* Bug 45 (19 May Ali) — every place that used to push to
          sessionError now uses the toast store instead, so this red
          banner shouldn't render in normal flow. Kept the conditional
          so legacy code paths still surface SOMETHING, but auto-dismiss
          after 3s and the X stays so you can close earlier. */}
      {sessionError && (
        <AutoDismissErrorBanner message={sessionError} onClose={() => setError(null)} />
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

      {/* Main content + chat panel layout.
          Bug D (15 May Ali) — when an admin/super_admin hasn't picked a
          role yet, block the entire content area (no lobby, no video,
          no chat, no participant list, no host controls) so the choice
          is unambiguously the first thing they do. The Join-as banner
          above is the only thing that can move them out of this state. */}
      <div className="flex-1 flex overflow-hidden relative">
        {mustPickRole && (
          <div
            className="flex-1 flex items-center justify-center px-6 py-12 text-center"
            data-testid="must-pick-role-blocker"
          >
            <div className="max-w-md">
              <p className="text-base font-medium text-gray-800 mb-1.5">
                Pick how you're joining first
              </p>
              <p className="text-sm text-gray-500">
                Use <span className="font-medium text-indigo-700">Join as host</span> or
                <span className="font-medium text-indigo-700"> Join as participant</span> at
                the top to enter the event. You can switch later from the same banner.
              </p>
            </div>
          </div>
        )}
        {/* Session content + side panels — hidden until the admin/super_admin
            has picked a role (Bug D). Pre-pick screen above takes the whole
            content area so the choice is unambiguous. */}
        {!mustPickRole && (
          <>
            {/* Bug 9 (18 May Stefan) — pre-fix, opening chat on mobile
                hid the lobby/video entirely (`hidden sm:flex`), which
                Stefan called out as taking over the whole screen. The
                content stays visible at all times now; chat sits ON TOP
                as a positioned overlay on mobile (see chat panel block
                below) and as a side panel on desktop. */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {phase === 'lobby' && <SectionErrorBoundary name="Lobby"><Lobby isHost={isHost} sessionId={sessionId} /></SectionErrorBoundary>}
              {phase === 'matched' && <SectionErrorBoundary name="Video"><VideoRoom isHost={isHost} /></SectionErrorBoundary>}
              {phase === 'rating' && <SectionErrorBoundary name="Rating"><RatingPrompt sessionId={sessionId} /></SectionErrorBoundary>}
              {phase === 'complete' && <SessionComplete sessionId={sessionId} />}
            </div>

            {/* Participant list panel — Bug 10: hidden once event is complete. */}
            {participantListOpen && !chatOpen && phase !== 'complete' && (
              <div className="w-full sm:w-72 sm:min-w-[288px] flex-shrink-0 h-full border-l border-white/10">
                <ParticipantList onClose={() => setParticipantListOpen(false)} sessionId={sessionId} />
              </div>
            )}

            {/* Chat panel — Bug 9 (18 May Stefan) + Bug 50 (19 May Stefan):
                two mobile layouts depending on phase.
                  - Lobby phase: right-anchored overlay (78% width, full
                    height) — original Bug 9 behaviour, preserved for the
                    pre-event waiting room where the video tiles are small
                    and the user mainly chats with the group.
                  - Matched phase (breakout room): BOTTOM SHEET — chat
                    takes the bottom 40% of the viewport, the breakout
                    video occupies the top 60%. Stefan flagged 19 May:
                    "the user is not able to see himself and the other
                    participant while chatting". Bottom-sheet matches
                    the standard mobile pattern (Meet, WhatsApp) and
                    keeps the conversation visible during the call.
                On sm+ screens both phases use the desktop side-by-side
                layout (unchanged). Bug 10: hidden once event is complete. */}
            {chatOpen && phase !== 'complete' && (
              <>
                {/* Mobile backdrop — covers the area NOT taken by the chat
                    panel so a tap there closes the panel.
                      - Lobby: full screen behind the 78% right panel, dimmed.
                      - Matched: only the top 60% (above the bottom-sheet),
                        transparent so the breakout video stays clearly
                        visible (no dim over the live faces). */}
                <div
                  data-testid="chat-mobile-backdrop"
                  className={`sm:hidden absolute z-30 ${
                    phase === 'matched'
                      ? 'left-0 right-0 top-0 bottom-[40%] bg-transparent'
                      : 'inset-0 bg-black/30'
                  }`}
                  onClick={() => setChatOpen(false)}
                  aria-hidden="true"
                />
                <div
                  className={`absolute z-40 shadow-2xl sm:static sm:w-80 sm:min-w-[320px] sm:h-auto sm:left-auto sm:right-auto sm:top-auto sm:bottom-auto sm:flex-shrink-0 sm:shadow-none sm:max-w-none ${
                    phase === 'matched'
                      ? 'left-0 right-0 bottom-0 h-[40%]'
                      : 'right-0 top-0 bottom-0 w-[78%] max-w-sm h-full'
                  }`}
                >
                  <SectionErrorBoundary name="Chat"><ChatPanel sessionId={sessionId} onClose={() => setChatOpen(false)} /></SectionErrorBoundary>
                </div>
              </>
            )}

            {/* Reaction bar — toggleable, bottom-left */}
            {phase !== 'complete' && phase !== 'rating' && sessionId && (
              <ReactionBar sessionId={sessionId} />
            )}
          </>
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

// Bug 45 (19 May Ali) — auto-dismiss the legacy red error banner so a
// stale session error never sits there until manually closed. 3 seconds
// (closer to Ali's preferred 1s but still readable). The X stays so the
// user can dismiss faster if they want.
function AutoDismissErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  return (
    <div className="bg-red-500/15 px-4 py-2 flex items-center justify-center gap-2">
      <AlertCircle className="h-4 w-4 text-red-400" />
      <p className="text-sm text-red-400">{message}</p>
      <button onClick={onClose} className="ml-2 text-red-400 hover:text-red-300">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function EventStateBanner({ sessionStatus, currentRound, totalRounds, bonusRoundsAdded }: { sessionStatus: string; currentRound: number; totalRounds: number; bonusRoundsAdded?: number; phase?: string }) {
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

  // Bug 28 (19 May Ali + Stefan) — flag the current round as bonus when
  // it falls past the originally-configured numberOfRounds. Example:
  // event configured for 3, "Another Round" pressed once → totalRounds=4,
  // bonusRoundsAdded=1 → originalRounds=3 → round 4 is a bonus round.
  const bonusCount = bonusRoundsAdded ?? 0;
  const originalRounds = totalRounds - bonusCount;
  const isBonusRound = bonusCount > 0
    && currentRound > 0
    && currentRound > originalRounds
    && sessionStatus !== 'completed'
    && sessionStatus !== 'scheduled';

  return (
    <div className={`px-4 py-1.5 flex items-center justify-center gap-2 text-xs font-medium ${config.color}`}>
      {config.icon}
      <span>{display}</span>
      {isBonusRound && (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-900 bg-amber-100 border border-amber-300 rounded-full px-1.5 py-px">
          Bonus
        </span>
      )}
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
