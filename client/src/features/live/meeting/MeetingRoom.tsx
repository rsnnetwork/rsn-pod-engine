// ─── The video-meeting room (26 Oct 2026, VID-01..04) ──────────────────────────
//
// What a video meeting is on screen, chosen once by LiveSessionPage from the event's
// format (liveKindOf(resolveEventFormat(session))). Speed networking keeps its own
// tree. A meeting has no rounds, so none of their chrome: no round chip, no check-in,
// no density toggle, no event plan, no host bar, no automatic host tile. Instead:
//   - before it starts, the camera check, with "Waiting for {host} to start the
//     meeting" for a guest and "Start meeting" in the bar for whoever runs it;
//   - once started, the stage (MeetingStage) and one bottom bar for everyone
//     (MeetingControlBar) inside the meeting's own <LiveKitRoom> on the lobby token;
//   - chat and people beside the stage, or under it on a phone, shrinking the
//     stage instead of covering it;
//   - when it ends, "Meeting ended" (MeetingEnded), or the removed message.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LiveKitRoom, RoomAudioRenderer, useAudioPlayback, useRoomContext } from '@livekit/components-react';
import '@livekit/components-styles';
import { VideoPresets } from 'livekit-client';
import { AlertCircle, Check, Loader2, RefreshCw, UserPlus, Volume2, WifiOff, X } from 'lucide-react';
import { useInRoomParticipants, useSessionStore } from '@/stores/sessionStore';
import { useToastStore } from '@/stores/toastStore';
import ToastContainer from '@/components/ui/Toast';
import Modal from '@/components/ui/Modal';
import { SectionErrorBoundary } from '@/components/ErrorBoundary';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { connectSocket } from '@/lib/socket';
import { BG_CAPTURE_RESOLUTION } from '@/lib/backgroundEffects';
import { LiveKitPresenceSync, PreLobbyWaitingRoom } from '../Lobby';
import { ReconnectOnReturn } from '../VideoRoom';
import { BgCameraPublisher } from '../BgCameraPublisher';
import ChatPanel from '../ChatPanel';
import ParticipantList from '../ParticipantList';
import { useEventInviteLink } from '../useEventInviteLink';
import MeetingStage from './MeetingStage';
import MeetingControlBar from './MeetingControlBar';
import MeetingEnded from './MeetingEnded';
import { clearMicChoiceMarkers } from './useLocalMediaToggles';
import { isRetryableRoomError, ROOM_RETRY_DELAY_MS, ROOM_RETRY_LIMIT, ROOM_STABLE_MS } from './roomRetry';

/** The event as GET /sessions/:id returns it (the fields the room reads). */
export interface MeetingSession {
  title?: string | null;
  podId?: string | null;
  hostUserId?: string | null;
  status?: string | null;
  config?: { maxParticipants?: number } | null;
}

export interface MeetingRoomProps {
  sessionId: string;
  session: MeetingSession;
  isDirector: boolean;
  /** Runs the meeting: the director, a co-host or a super_admin. */
  canManage: boolean;
  /** May end it for everyone: the director or a super_admin. */
  canEndEvent: boolean;
  /** The browser refused the camera or microphone. */
  mediaError: boolean;
  onDismissMediaError: () => void;
}

/** How long the stage waits for its video room before saying so (it keeps trying). */
const VIDEO_WAIT_MS = 15_000;

function MeetingInviteDialog({ sessionId, open, onClose, maxUses }: { sessionId: string; open: boolean; onClose: () => void; maxUses: number }) {
  const { url, failed } = useEventInviteLink(sessionId, open, maxUses);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      useToastStore.getState().addToast("We couldn't copy the link. Select it and copy it yourself.", 'error');
    }
  };
  return (
    <Modal open={open} onClose={onClose} className="max-w-md">
      <div role="dialog" aria-modal="true" aria-labelledby="meeting-invite-title" className="pt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="meeting-invite-title" className="flex items-center gap-2 text-lg font-semibold text-[#1a1a2e]">
            <UserPlus className="h-5 w-5 text-emerald-600" aria-hidden="true" /> Invite people
          </h2>
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <label htmlFor="meeting-invite-link" className="mt-3 block text-xs font-medium text-gray-700">Share this link</label>
        <div className="mt-1.5 flex items-stretch gap-2">
          <input
            id="meeting-invite-link"
            type="text"
            readOnly
            value={url}
            placeholder={failed ? 'No link available' : 'Preparing your link…'}
            data-testid="live-invite-link"
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 font-mono text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
          <button
            type="button"
            disabled={!url}
            onClick={() => { void copy(); }}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg bg-[#1a1a2e] px-4 text-sm font-semibold text-white hover:bg-[#2a2a40] disabled:opacity-50"
          >
            {copied ? <><Check className="h-4 w-4" aria-hidden="true" /> Copied</> : 'Copy link'}
          </button>
        </div>
        <p className={`mt-2 text-xs ${failed ? 'text-red-600' : 'text-gray-500'}`}>
          {failed
            ? 'We could not prepare an invite link. You can invite people from the event page.'
            : 'Anyone with this link can join the event. It stays valid for 7 days.'}
        </p>
      </div>
    </Modal>
  );
}

/** Browsers can block sound until the page is tapped (iOS Safari after a refresh): one tap turns it on. */
function AudioUnlock() {
  const room = useRoomContext();
  const { canPlayAudio, startAudio } = useAudioPlayback(room);
  if (canPlayAudio) return null;
  return (
    <button
      type="button"
      onClick={() => { void startAudio(); }}
      className="pointer-events-auto inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-[#1a1a2e] shadow-lg"
    >
      <Volume2 className="h-4 w-4" aria-hidden="true" /> Tap to turn on sound
    </button>
  );
}

function MeetingTopBar({ title }: { title: string }) {
  return (
    // A phone on its side hides this bar: its height is the stage's.
    <header className="flex min-h-[48px] shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-3 sm:px-4 [@media(max-height:500px)_and_(orientation:landscape)]:hidden">
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#1a1a2e]">{title}</h1>
    </header>
  );
}

function MeetingNotices({ mediaError, onDismissMediaError }: { mediaError: boolean; onDismissMediaError: () => void }) {
  const connectionStatus = useSessionStore((s) => s.connectionStatus);
  const transitionStatus = useSessionStore((s) => s.transitionStatus);
  const reconnectCount = useSessionStore((s) => s.reconnectCount);
  const evicted = transitionStatus === 'evicted';
  return (
    <>
      {connectionStatus === 'reconnecting' && (
        <div role="status" className="flex shrink-0 items-center justify-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          {reconnectCount >= 2 ? 'Reconnecting… your connection looks unstable. We’ll get you back in automatically.' : 'Reconnecting…'}
        </div>
      )}
      {connectionStatus === 'disconnected' && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center justify-center gap-2 bg-red-50 px-4 py-1 text-sm text-red-700">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          {evicted ? 'You joined this meeting from another tab or device.' : "You've been disconnected."}
          <button
            type="button"
            // A new page takes the meeting back from the other tab, the same as the live page's own banner.
            onClick={() => { if (evicted) window.location.reload(); else connectSocket(); }}
            className="inline-flex min-h-[44px] items-center gap-1 px-2 font-semibold underline"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> {evicted ? 'Rejoin here' : 'Rejoin'}
          </button>
        </div>
      )}
      {mediaError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 bg-amber-50 py-1 pl-4 pr-1 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">Your camera or microphone is blocked. Allow them for this site in your browser settings so the others can see and hear you.</span>
          <button type="button" aria-label="Dismiss" onClick={onDismissMediaError} className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg hover:bg-amber-100">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

/** Started, but the video room is not there yet: say so, and after a while say we are still trying. */
function VideoComing() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), VIDEO_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div data-testid="meeting-stage" data-layout="connecting" className="flex flex-1 flex-col items-center justify-center gap-3 bg-[#202124] px-6 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-gray-300" aria-hidden="true" />
      <p className="text-sm text-gray-200">Joining the meeting…</p>
      {slow && <p className="max-w-xs text-xs text-gray-400">The video is taking longer than usual. We'll keep trying; you can chat in the meantime.</p>}
    </div>
  );
}

export default function MeetingRoom({ sessionId, session, isDirector, canManage, canEndEvent, mediaError, onDismissMediaError }: MeetingRoomProps) {
  const phase = useSessionStore((s) => s.phase);
  const transitionStatus = useSessionStore((s) => s.transitionStatus);
  const removedFromEvent = useSessionStore((s) => s.removedFromEvent);
  const storeStatus = useSessionStore((s) => s.sessionStatus);
  const sessionStateLoaded = useSessionStore((s) => s.sessionStateLoaded);
  const lobbyToken = useSessionStore((s) => s.lobbyToken);
  const lobbyUrl = useSessionStore((s) => s.lobbyUrl);
  const chatOpen = useSessionStore((s) => s.chatOpen);
  const unreadChat = useSessionStore((s) => s.unreadChatCount);
  const setChatOpen = useSessionStore((s) => s.setChatOpen);
  const people = useInRoomParticipants();
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roomKey, setRoomKey] = useState(0);
  // Connection retries spent on this room (roomRetry.ts): only a connection failure spends one, and they are
  // counted afresh after a stable minute or when the person comes back to the page.
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Leaving the meeting: no retry may fire after it, and its mic markers go (SIDs are never reused).
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (stableTimer.current) clearTimeout(stableTimer.current);
    clearMicChoiceMarkers();
  }, []);

  // The director's name, for "Waiting for {host} to start the meeting" and the co-host note. The host is
  // registered as a participant when the event is made, so the event's own list always has them.
  const { data: roster } = useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then((r) => (r.data.data ?? []) as Array<{ userId: string; displayName?: string | null }>),
    enabled: !!sessionId,
    meta: { entities: [E.session(sessionId), E.sessionParticipants(sessionId)] },
  });
  const hostName = roster?.find((p) => p.userId === session.hostUserId)?.displayName?.trim() || 'the host';

  // Until the live state has arrived, the event's own status says whether it has started (the store starts
  // at 'scheduled', which would flash the waiting screen on a meeting that is running).
  const status = sessionStateLoaded ? storeStatus : (session.status ?? storeStatus);
  const preStart = status === 'scheduled';
  // Over the moment the server says so: session:completed, or the live status itself, which reaches a
  // person whose socket joined just after the end (the join's state and the REST snapshot) and who
  // would otherwise wait for the page's 30-second refetch.
  const ended = phase === 'complete' || transitionStatus === 'session_ending' || status === 'completed' || status === 'cancelled';

  // D (25 May) — iOS Safari suspends WebRTC in the background and the SDK's own reconnect can give up. On
  // return, take a fresh token and connect the room again. Never for a tab that was replaced by another
  // (it would take the room back from it), nor once the meeting is over.
  const reconnectRoom = useCallback(() => {
    retryTimer.current = null;
    const st = useSessionStore.getState();
    if (st.phase === 'complete' || st.transitionStatus === 'evicted' || st.removedFromEvent
      || st.sessionStatus === 'completed' || st.sessionStatus === 'cancelled') return;
    api.post(`/sessions/${sessionId}/token`, {})
      .then((res) => {
        const td = res.data?.data;
        if (td?.token) useSessionStore.getState().setLobbyToken(td.token, td.livekitUrl, td.roomId ?? null);
      })
      .catch(() => { /* the room is connected again below with the token it already holds */ })
      .finally(() => setRoomKey((k) => k + 1));
  }, [sessionId]);

  // The person came back to the page: a fresh start, so the retries are counted afresh.
  const reconnectOnReturn = useCallback(() => {
    retries.current = 0;
    reconnectRoom();
  }, [reconnectRoom]);

  // A connection that holds for a minute earns its retries back. Not on every connect: a connection that
  // drops again at once would then retry for ever.
  const onRoomConnected = () => {
    if (stableTimer.current) clearTimeout(stableTimer.current);
    stableTimer.current = setTimeout(() => { retries.current = 0; stableTimer.current = null; }, ROOM_STABLE_MS);
  };
  const onRoomDisconnected = () => {
    if (stableTimer.current) clearTimeout(stableTimer.current);
    stableTimer.current = null;
  };
  // Only a connection failure is tried again, at most ROOM_RETRY_LIMIT times, with a fresh token. A camera or
  // microphone that cannot open is not a reason to reconnect: the person stays in, with that device off.
  const onRoomError = (err: Error) => {
    if (!isRetryableRoomError(err) || retries.current >= ROOM_RETRY_LIMIT || retryTimer.current) return;
    retries.current += 1;
    retryTimer.current = setTimeout(reconnectRoom, ROOM_RETRY_DELAY_MS);
  };

  const toggleChat = () => { setPeopleOpen(false); setChatOpen(!chatOpen); };
  const togglePeople = () => { setChatOpen(false); setPeopleOpen((v) => !v); };
  const openInvite = () => setInviteOpen(true);

  const panel: ReactNode = chatOpen ? (
    <aside className="flex h-[45dvh] shrink-0 flex-col sm:h-auto sm:w-80" aria-label="Chat">
      {/* Open to everyone once the meeting runs, director there or not; the bar below already clears the
          iPhone home indicator, so the chat adds no inset of its own. */}
      <SectionErrorBoundary name="Chat">
        <ChatPanel sessionId={sessionId} onClose={() => setChatOpen(false)} alwaysOpen={!preStart} padBottomInset={false} />
      </SectionErrorBoundary>
    </aside>
  ) : peopleOpen ? (
    <aside className="flex h-[45dvh] shrink-0 flex-col bg-[#292a2d] sm:h-auto sm:w-72" aria-label="People">
      {canManage && (
        <div className="shrink-0 px-3 pt-3">
          <button
            type="button"
            onClick={openInvite}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-white/10 text-sm font-semibold text-gray-100 hover:bg-white/20"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Invite people
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ParticipantList onClose={() => setPeopleOpen(false)} sessionId={sessionId} isHost={canManage} />
      </div>
    </aside>
  ) : null;

  const frame = (stage: ReactNode, inRoom: boolean) => (
    <>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{stage}</div>
        {panel}
      </div>
      <MeetingControlBar
        sessionId={sessionId}
        inRoom={inRoom}
        preStart={preStart}
        canManage={canManage}
        canEndEvent={canEndEvent}
        isDirector={isDirector}
        directorName={hostName}
        chatOpen={chatOpen}
        unreadChat={unreadChat}
        onToggleChat={toggleChat}
        peopleOpen={peopleOpen}
        peopleCount={people.length}
        onTogglePeople={togglePeople}
      />
    </>
  );

  let body: ReactNode;
  if (ended) {
    body = <MeetingEnded sessionId={sessionId} podId={session.podId} removed={removedFromEvent} />;
  } else if (preStart) {
    body = frame(
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PreLobbyWaitingRoom
          isHost={canManage}
          sessionId={sessionId}
          waitingLabel={canManage ? 'Start the meeting when you are ready' : `Waiting for ${hostName} to start the meeting`}
        />
      </div>,
      false,
    );
  } else if (lobbyToken && lobbyUrl) {
    body = (
      <LiveKitRoom
        key={roomKey}
        token={lobbyToken}
        serverUrl={lobbyUrl}
        connect={true}
        // The camera is the EVENT-SCOPED engine track, published by BgCameraPublisher (as in every room).
        video={false}
        // The mic follows the person's last choice, applied once per connection by useLocalMediaToggles. Never
        // through `audio`: <LiveKitRoom> re-applies it on every connection, which unmuted a person who had muted.
        audio={false}
        className="flex min-h-0 flex-1 flex-col"
        onConnected={onRoomConnected}
        onDisconnected={onRoomDisconnected}
        onError={onRoomError}
        options={{
          // C2/VID-1 — the same video diet as the other two rooms: each remote video at the layer its tile
          // needs, off-screen video paused, unused layers not encoded. Audio is never affected.
          adaptiveStream: true,
          dynacast: true,
          videoCaptureDefaults: { resolution: { ...BG_CAPTURE_RESOLUTION } },
          publishDefaults: {
            videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
            videoEncoding: { maxBitrate: 800_000, maxFramerate: 24 },
          },
          audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }}
      >
        <LiveKitPresenceSync />
        <BgCameraPublisher />
        <RoomAudioRenderer />
        <ReconnectOnReturn onReconnect={reconnectOnReturn} />
        {frame(
          <SectionErrorBoundary name="Meeting">
            <MeetingStage onInvite={canManage ? openInvite : undefined} notices={<AudioUnlock />} />
          </SectionErrorBoundary>,
          true,
        )}
      </LiveKitRoom>
    );
  } else {
    body = frame(<VideoComing />, false);
  }

  return (
    <div className="flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-white pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <ToastContainer hostQuiet={canManage} />
      <MeetingTopBar title={session.title || 'Video meeting'} />
      <MeetingNotices mediaError={mediaError} onDismissMediaError={onDismissMediaError} />
      {body}
      {canManage && (
        <MeetingInviteDialog sessionId={sessionId} open={inviteOpen} onClose={() => setInviteOpen(false)} maxUses={session.config?.maxParticipants ?? 25} />
      )}
    </div>
  );
}
