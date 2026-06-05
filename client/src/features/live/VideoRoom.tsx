import { useEffect, useState, useCallback, useRef, memo } from 'react';
import { useParams } from 'react-router-dom';
import { useSessionStore } from '@/stores/sessionStore';
import { formatTime } from '@/lib/utils';
import { Video, Clock, Mic, MicOff, VideoOff, Wifi, Loader2, ArrowLeft, Sparkles } from 'lucide-react';
import { useBackgroundEffects } from '@/hooks/useBackgroundEffects';
import { BackgroundPanel } from './BackgroundPanel';
import { BG_CAPTURE_RESOLUTION } from '@/lib/backgroundEffects';
import { getSocket } from '@/lib/socket';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useParticipants,
  useLocalParticipant,
  useRoomContext,
  RoomAudioRenderer,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track, ConnectionState } from 'livekit-client';
import api from '@/lib/api';

// Prefer displayName → name → email local-part → "Partner".
// Avoids raw email addresses (and their trailing @domain) rendering full-width
// across the video tile when displayName is missing.
function userDisplayLabel(
  input?: { displayName?: string | null; email?: string | null; name?: string | null } | string | null,
): string {
  if (!input) return 'Partner';
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return 'Partner';
    return trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  }
  const asAny = input as { displayName?: string | null; name?: string | null; email?: string | null };
  if (asAny.displayName && String(asAny.displayName).trim()) return String(asAny.displayName).trim();
  if (asAny.name && String(asAny.name).trim()) return String(asAny.name).trim();
  if (asAny.email) return String(asAny.email).split('@')[0];
  return 'Partner';
}

// Bug 8.7 (April 19) — memo'd. ConnectionIndicator has no props/state so
// React skips re-render when the parent re-renders for unrelated reasons
// (timer tick, dashboard update, etc.). Eliminates the visible flashing
// reported during live testing on the breakout-room toolbar.
const ConnectionIndicator = memo(function ConnectionIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
      <Wifi className="h-3 w-3 text-emerald-400" />
      <span className="text-xs text-emerald-400">Connected</span>
    </div>
  );
});

// Bug 10 (April 19) — anchored reaction badge above the tile name.
// Subscribes ONLY to the per-user reaction entry so unrelated tiles
// don't re-render when a different person reacts. Auto-clears after 8s.
const TileReaction = memo(function TileReaction({ userId }: { userId?: string }) {
  const reaction = useSessionStore(s => userId ? s.tileReactions[userId] : undefined);
  if (!reaction) return null;
  return (
    <div className="absolute bottom-10 left-2 flex items-center gap-1 bg-black/80 text-white rounded-full px-2 py-0.5 shadow-lg animate-fade-in pointer-events-none z-20">
      <span className="text-base leading-none">{reaction.emoji}</span>
      <span className="text-[10px] font-medium truncate max-w-[120px]">{reaction.displayName}</span>
    </div>
  );
});

function VideoTile({ trackRef, label, isWaiting, isPinned, userId, fillMode = 'contain' }: { trackRef?: any; label: string; isWaiting?: boolean; isPinned?: boolean; userId?: string; fillMode?: 'contain' | 'cover' }) {
  const hasVideo = trackRef?.publication?.track;
  // Bug 2 + Bug 6 (April 18 Dr Arch): VideoTile fills its parent cell, but
  // the inner VideoTrack uses object-CONTAIN (not cover). Reasoning:
  //   - object-cover crops the source to fill the cell. Portrait phone video
  //     rendered in a landscape desktop tile gets aggressively zoomed in so
  //     only the centre slice of the face is visible (Bug #6).
  //   - object-contain preserves the full source frame and pads with the
  //     tile's bg colour (black for video tiles) — matches the way Google
  //     Meet shows portrait video on desktop without cropping.
  // The black `bg-black` parent makes the letterbox feel intentional and
  // unobtrusive instead of looking like a broken tile.
  return (
    <div className={`relative rounded-xl overflow-hidden ${fillMode === 'contain' ? 'rsn-tile-contain' : ''} ${hasVideo ? 'bg-black' : 'bg-[#3c4043]'} ${isPinned ? 'h-full w-full' : 'h-full w-full'} flex items-center justify-center`}>
      {hasVideo ? (
        <VideoTrack trackRef={trackRef} className={`h-full w-full ${fillMode === 'contain' ? 'object-contain' : 'object-cover'}`} />
      ) : (
        <div className="flex flex-col items-center gap-2">
          <div className={`h-20 w-20 rounded-full bg-[#5f6368] flex items-center justify-center ${isWaiting ? 'animate-pulse' : ''}`}>
            <Video className={`h-8 w-8 ${isWaiting ? 'text-gray-500' : 'text-gray-400'}`} />
          </div>
          <p className="text-gray-400 text-sm">
            {isWaiting ? 'Waiting for partner...' : `${label} — camera off`}
          </p>
        </div>
      )}
      <div className="absolute bottom-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-white max-w-[60%] truncate">
        {label}
      </div>
      <TileReaction userId={userId} />
    </div>
  );
}

// Bug 8.7 (April 19) — memo'd. VideoStage has no props; its internal
// selectors (currentPartners, useTracks, useParticipants) trigger their
// own re-renders when relevant. Memoization stops it from re-rendering
// when the parent VideoRoom re-renders for unrelated reasons.
const VideoStage = memo(function VideoStage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.Microphone, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  useParticipants(); // Keep subscribed for LiveKit track updates
  const { localParticipant } = useLocalParticipant();
  // Bug 8.7 (April 19) — selector pattern (was destructuring whole store).
  // Whole-store subscriptions made VideoStage re-render on EVERY field
  // change in the store (timer tick, dashboard refresh, participant
  // updates, etc.) which propagated to MediaControls + Leave/Main Room
  // buttons, causing the visible "flashing" reported during live testing.
  const currentPartners = useSessionStore(s => s.currentPartners);
  // Phase N + T (12 May spec item 2) — visibility modes apply in
  // breakouts too. Phase N filtered hidden only; Phase T also handles
  // 'producer' (audio-only pill row below the grid). 'big_speaker' in a
  // 2-3 person breakout doesn't need a special render — the tile is
  // already prominent. Local tile is exempt from filtering (the
  // participant always sees their own preview).
  const hostVisibilityModes = useSessionStore(s => s.hostVisibilityModes);
  const [pinnedSid, setPinnedSid] = useState<string | null>(null);

  const cameraTracks = tracks.filter(t => t.source === Track.Source.Camera);
  const localTrack = cameraTracks.find(t => t.participant.sid === localParticipant.sid);
  // Phase T — filter remoteTracks BEFORE downstream render paths use them.
  // Local tile is exempt (the participant always sees their own preview).
  // Hidden users are dropped from the room entirely. Producer users get
  // pulled into a separate audio-only pill row so they don't take up a
  // video tile slot in the 2-3 person breakout grid.
  const modeFor = (uid: string | undefined): 'big_speaker' | 'normal' | 'producer' | 'hidden' => {
    if (!uid) return 'normal';
    const m = hostVisibilityModes[uid];
    return m === 'big_speaker' || m === 'producer' || m === 'hidden' ? m : 'normal';
  };
  const remoteTracksAll = cameraTracks.filter(t => t.participant.sid !== localParticipant.sid);
  const producerTracks = remoteTracksAll.filter(t => modeFor(t.participant.identity) === 'producer');
  const remoteTracks = remoteTracksAll.filter(t => {
    const m = modeFor(t.participant.identity);
    return m !== 'hidden' && m !== 'producer';
  });

  type Tile = {
    trackRef: any;
    label: string;
    sid: string;
    userId: string | undefined;
  };

  const allTiles: Tile[] = [
    { trackRef: localTrack, label: 'You', sid: localParticipant.sid, userId: localParticipant.identity },
    ...remoteTracks.map((rt, i) => ({
      trackRef: rt,
      label: userDisplayLabel(rt.participant.name || currentPartners[i]),
      sid: rt.participant.sid,
      userId: rt.participant.identity as string | undefined,
    })),
  ];

  const pinnedTile = pinnedSid ? allTiles.find(t => t.sid === pinnedSid) : null;
  const unpinnedTiles = pinnedSid ? allTiles.filter(t => t.sid !== pinnedSid) : allTiles;

  const isTrio = currentPartners.length > 1;
  const gridClass = isTrio
    ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
    : 'grid-cols-1 md:grid-cols-2';

  if (pinnedTile) {
    return (
      <div className="flex-1 flex flex-col gap-3 max-h-[calc(100dvh-160px)]">
        {/* Pinned tile — large. Bug 6.5: same aspect-video cap as the grid
            cells so the pinned tile matches webcam source aspect (16:9)
            and avoids the huge black bar below the video on tall windows. */}
        <div className="flex-1 min-h-0 flex items-center justify-center cursor-pointer" onClick={() => setPinnedSid(null)}>
          <div className="relative w-full" style={{ aspectRatio: '16 / 9', maxHeight: '100%' }}>
            <VideoTile trackRef={pinnedTile.trackRef} label={pinnedTile.label} isPinned userId={pinnedTile.userId} />
            <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-2 py-0.5 rounded-full">
              Pinned · click to unpin
            </div>
          </div>
        </div>
        {/* Unpinned tiles — small row */}
        <div className="flex gap-3 h-28 shrink-0">
          {unpinnedTiles.map(t => (
            <div key={t.sid} className="flex-1 cursor-pointer" onClick={() => setPinnedSid(t.sid)}>
              <VideoTile trackRef={t.trackRef} label={t.label} userId={t.userId} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Mobile 1:1: stacked layout — partner 60%, self 40% (FaceTime/Google Meet style)
  // Mobile trio: partner grid + larger floating self-view
  // Desktop: side-by-side equal grid tiles
  return (
    <div className="flex-1 relative max-h-[calc(100dvh-160px)]">
      {remoteTracks.length > 0 ? (
        <>
          {/* Desktop: equal grid tiles including self-view.
              Bug 2 (April 18) — cells are h-full so VideoTile fills vertically.
              Bug 6.5 (April 19) — cap each tile to 16:9 aspect ratio so the
              tile matches the webcam source (which is universally 16:9). The
              previous "fill the cell" approach made each cell ~960×920
              (almost square) on a 1920px-wide desktop; with object-contain
              that left huge black bars below the video. Now: cells flex-
              center the inner tile with aspect-ratio 16/9 + max-h-full, so
              the tile is naturally sized like a Google Meet tile (width =
              column, height = width × 9/16). On short windows max-h-full
              caps the height and width shrinks proportionally to maintain
              the aspect ratio — no distortion, no overflow. */}
          {/* Phase E (10 May spec) — desktop layout mirrors mobile/Google Meet
              now: remote partner(s) take the main stage, self is a PIP in the
              corner. Pre-fix the desktop grid put the local "You" tile
              alongside the remote tiles at the same size, so the user often
              perceived themselves as the big tile (Stefan #12). The pinned-
              tile behavior is unchanged — clicking any tile (including the
              self PIP) pins it large. Self as PIP keeps the user oriented
              ("am I on camera?") without dominating the screen.

              Pair (you + 1):    partner full-stage,    self PIP top-right
              Trio (you + 2):    2 partners in 2-col grid, self PIP top-right
              Quad+ (you + 3+):  responsive grid for partners, self PIP    */}
          <div className="hidden md:block h-full relative">
            {!isTrio && remoteTracks.length === 1 ? (
              // Pair: single partner full-stage
              <div className="h-full flex items-center justify-center cursor-pointer"
                onClick={() => setPinnedSid(remoteTracks[0].participant.sid)}>
                <div className="w-full" style={{ aspectRatio: '16 / 9', maxHeight: '100%' }}>
                  <VideoTile
                    trackRef={remoteTracks[0]}
                    label={userDisplayLabel(remoteTracks[0].participant.name || currentPartners[0])}
                    userId={remoteTracks[0].participant.identity}
                  />
                </div>
              </div>
            ) : (
              // Trio / quad+: remote partners in a grid
              <div className={`h-full grid gap-4 ${remoteTracks.length === 2 ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-3'}`}>
                {remoteTracks.map((rt, i) => (
                  <div key={rt.participant.sid} className="h-full flex items-center justify-center cursor-pointer"
                    onClick={() => setPinnedSid(rt.participant.sid)}>
                    <div className="w-full" style={{ aspectRatio: '16 / 9', maxHeight: '100%' }}>
                      <VideoTile
                        trackRef={rt}
                        label={userDisplayLabel(rt.participant.name || currentPartners[i])}
                        userId={rt.participant.identity}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Self PIP — top-right corner. Click to pin large. */}
            <div
              data-self="true"
              className="absolute top-3 right-3 w-44 lg:w-52 rounded-xl overflow-hidden shadow-lg border-2 border-white/80 z-10 bg-black cursor-pointer ring-2 ring-rsn-red/30"
              style={{ aspectRatio: '16 / 9' }}
              onClick={() => setPinnedSid(localParticipant.sid)}
              title="Click to pin yourself"
            >
              <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} fillMode="cover" />
            </div>
          </div>

          {/* Mobile 1:1: WhatsApp/Google Meet style — partner full screen, self-view PIP top-right */}
          {!isTrio && (
            <div className="md:hidden h-full relative">
              <div className="h-full cursor-pointer" onClick={() => setPinnedSid(remoteTracks[0].participant.sid)}>
                <VideoTile trackRef={remoteTracks[0]} label={userDisplayLabel(remoteTracks[0].participant.name || currentPartners[0])} userId={remoteTracks[0].participant.identity} />
              </div>
              <div
                className="absolute top-3 right-3 w-32 h-44 sm:w-36 sm:h-48 rounded-xl overflow-hidden shadow-lg border-2 border-white/80 z-10 bg-black"
                onClick={() => setPinnedSid(localParticipant.sid)}
                style={{ cursor: 'pointer' }}
              >
                <div className="absolute inset-0">
                  {/* Bug 16: PIP self-view uses cover mode — small portrait
                      container with portrait source looks too small with
                      contain (visible side bars shrink the user). */}
                  <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} fillMode="cover" />
                </div>
              </div>
            </div>
          )}

          {/* Mobile trio: remote participants split screen, self-view PIP top-right.
              Bug 2 (April 18 Dr Arch): each row cell is h-full + min-h-0 so the
              tiles fill vertically (otherwise aspect-video collapses them). */}
          {isTrio && (
            <div className="md:hidden h-full relative">
              <div className="h-full grid grid-cols-1 gap-2">
                {remoteTracks.map((rt, i) => (
                  <div key={rt.participant.sid} className="h-full min-h-0 cursor-pointer" onClick={() => setPinnedSid(rt.participant.sid)}>
                    <VideoTile trackRef={rt} label={userDisplayLabel(rt.participant.name || currentPartners[i])} userId={rt.participant.identity} />
                  </div>
                ))}
              </div>
              <div
                className="absolute top-3 right-3 w-32 h-44 sm:w-36 sm:h-48 rounded-xl overflow-hidden shadow-lg border-2 border-white/80 z-10 bg-black"
                onClick={() => setPinnedSid(localParticipant.sid)}
                style={{ cursor: 'pointer' }}
              >
                <div className="absolute inset-0">
                  {/* Bug 16: PIP self-view uses cover mode — small portrait
                      container with portrait source looks too small with
                      contain (visible side bars shrink the user). */}
                  <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} fillMode="cover" />
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className={`h-full grid ${gridClass} gap-4`}>
          <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} />
          {currentPartners.map((p, i) => (
            <VideoTile key={p.userId || i} label={userDisplayLabel(p)} isWaiting userId={p.userId} />
          ))}
        </div>
      )}
      {/* Phase T — producer strip. Audio-only host(s) in the breakout
          appear as small pills here; their video tile is suppressed so
          the partner grid stays uncluttered. Rare in practice (matching
          excludes hosts; producer-mode in breakouts requires a manual
          host:move_to_room AFTER setting visibility to 'producer'). */}
      {producerTracks.length > 0 && (
        <div
          data-testid="breakout-producer-strip"
          className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-[#1f2024]/80 backdrop-blur border border-[#3c4043] pointer-events-none"
        >
          <span className="text-[10px] uppercase tracking-wide text-gray-400 mr-1">
            Producers
          </span>
          {producerTracks.map(t => (
            <span
              key={t.participant.sid}
              className="inline-flex items-center gap-1 bg-black/40 text-white text-[11px] px-2 py-0.5 rounded-full"
              title="Off-camera operator — audio-only"
            >
              {t.participant.name || t.participant.identity || 'Producer'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

// Bug 8.7 (April 19) — memo'd. MediaControls has its own internal state
// (mic/cam/bg toggles) and doesn't depend on parent props. Memoization
// stops the toolbar from re-rendering on every timer tick.
const MediaControls = memo(function MediaControls() {
  const { localParticipant, isCameraEnabled: hookCamEnabled } = useLocalParticipant();
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [showBgPanel, setShowBgPanel] = useState(false);
  // All background-effect lifecycle (capability, persist-across-rooms,
  // degrade-then-disable, destroy-on-unmount) lives in this shared hook.
  const bg = useBackgroundEffects(localParticipant, hookCamEnabled);

  useEffect(() => {
    if (localParticipant) {
      setCamEnabled(localParticipant.isCameraEnabled);
    }
  }, [localParticipant]);

  const toggleMic = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!micEnabled);
    setMicEnabled(!micEnabled);
  }, [localParticipant, micEnabled]);

  const toggleCam = useCallback(async () => {
    const target = !camEnabled;
    try {
      if (!target) {
        await localParticipant.setCameraEnabled(false);
        setCamEnabled(false);
      } else {
        // Unpublish stale tracks first, then re-enable fresh
        for (const pub of localParticipant.videoTrackPublications.values()) {
          if (pub.track) {
            try { await localParticipant.unpublishTrack(pub.track); } catch { /* ignore */ }
          }
        }
        await localParticipant.setCameraEnabled(true);
        setCamEnabled(true);
        setTimeout(() => setCamEnabled(localParticipant.isCameraEnabled), 500);
      }
    } catch (err) {
      console.error('Camera toggle failed:', err);
      setCamEnabled(localParticipant.isCameraEnabled);
    }
  }, [localParticipant, camEnabled]);

  return (
    <div className="flex items-center gap-3 relative">
      <button onClick={toggleMic}
        className={`p-2 rounded-full transition-colors ${micEnabled ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-red-100 text-red-500 hover:bg-red-200'}`}>
        {micEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      </button>
      <button onClick={toggleCam}
        className={`p-2 rounded-full transition-colors ${camEnabled ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-red-100 text-red-500 hover:bg-red-200'}`}>
        {camEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
      </button>
      {bg.supported && (
        <button onClick={() => setShowBgPanel(!showBgPanel)} title="Background effects"
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors ${bg.current.mode !== 'disabled' ? 'bg-indigo-500/80 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'}`}>
          <Sparkles className="h-4 w-4" />
          BG
        </button>
      )}

      {showBgPanel && bg.supported && (
        <BackgroundPanel
          current={bg.current}
          degraded={bg.degraded}
          onApply={bg.apply}
          onClose={() => setShowBgPanel(false)}
        />
      )}
    </div>
  );
});

// WS2 (27 May remaining work) — "waiting for partner…" banner. Pre-WS2 this
// auto-emitted leave_conversation after 5s, which fought the SERVER's 15s
// grace: the survivor self-ejected before a partner mid-refresh could come
// back, and a reconnecting pair got torn down by their own client. Now the
// server alone decides the outcome:
//   - partner returns within 15s → match:partner_reconnected clears the
//     flag and the room resumes;
//   - grace expires → rating:window_open (reason 'partner_no_return') /
//     match:return_to_lobby tear the room down.
// The manual button stays — leaving NOW is a deliberate immediate room end.
// Deliberately does NOT set leftCurrentRound: the survivor never left, and
// a resumed room would otherwise be blocked by the stale-assign guard.
function PartnerWaitingBanner({ sessionId }: { sessionId: string }) {
  return (
    <div className="bg-amber-500/10 px-4 py-3 flex flex-wrap items-center justify-center gap-2">
      <Loader2 className="h-4 w-4 text-amber-400 animate-spin" />
      <p className="text-sm text-amber-400 font-medium">Waiting for your partner to reconnect…</p>
      <button
        onClick={() => getSocket()?.emit('participant:leave_conversation', { sessionId })}
        className="ml-2 min-h-[44px] px-4 py-1.5 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-full transition-colors"
      >
        Return to Main Room
      </button>
    </div>
  );
}

// D (25 May Ali) — recover the LiveKit connection when the user returns to the
// foreground. iOS Safari suspends WebRTC while a tab is backgrounded (a phone
// call, the lock screen); the SDK's own reconnect frequently times out
// (Sentry "NegotiationError: negotiation timed out"), leaving the participant
// with frozen/black video and a stale "ghost" tile to everyone else (the
// "Saif in two places" report). Mount once inside a <LiveKitRoom>: on return to
// the foreground / regained network, if the room has actually GIVEN UP
// (state === Disconnected), trigger the parent's reconnect. We act ONLY on a
// hard Disconnected state — transient blips are left to the SDK's own
// auto-reconnect so we never thrash a healthy or already-reconnecting link.
// Debounced so a burst of focus/visibility/online events fires at most once.
function ReconnectOnReturn({ onReconnect }: { onReconnect: () => void }) {
  const room = useRoomContext();
  const cbRef = useRef(onReconnect);
  cbRef.current = onReconnect;
  const debounceRef = useRef(false);
  useEffect(() => {
    const maybeReconnect = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (room.state !== ConnectionState.Disconnected) return;
      if (debounceRef.current) return;
      debounceRef.current = true;
      setTimeout(() => { debounceRef.current = false; }, 3000);
      cbRef.current();
    };
    document.addEventListener('visibilitychange', maybeReconnect);
    window.addEventListener('focus', maybeReconnect);
    window.addEventListener('online', maybeReconnect);
    return () => {
      document.removeEventListener('visibilitychange', maybeReconnect);
      window.removeEventListener('focus', maybeReconnect);
      window.removeEventListener('online', maybeReconnect);
    };
  }, [room]);
  return null;
}

export default function VideoRoom({ isHost = false }: { isHost?: boolean }) {
  const timerSeconds = useSessionStore(s => s.timerSeconds);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const isByeRound = useSessionStore(s => s.isByeRound);
  const liveKitToken = useSessionStore(s => s.liveKitToken);
  const livekitUrl = useSessionStore(s => s.livekitUrl);
  const currentRoomId = useSessionStore(s => s.currentRoomId);
  // T0-2 (Issue 7) — needed by onConnected to emit presence:room_joined
  // so the host dashboard can show real LiveKit-room presence instead of
  // false-positive "active" before WebRTC negotiation completes.
  const currentMatchId = useSessionStore(s => s.currentMatchId);
  const timerVisibility = useSessionStore(s => s.timerVisibility);
  const breakoutTimerHidden = useSessionStore(s => s.breakoutTimerHidden);
  const partnerDisconnected = useSessionStore(s => s.partnerDisconnected);
  const timerEndsAt = useSessionStore(s => s.timerEndsAt);
  const clockOffset = useSessionStore(s => s.clockOffset);
  const timerWarning = useSessionStore(s => s.timerWarning);
  const { setLiveKitToken } = useSessionStore.getState();
  const [retrying, setRetrying] = useState(false);
  const retryCountRef = useRef(0);
  const { sessionId } = useParams();

  // WS3/B3 (27 May remaining work) — "final stretch sticks". The displayed
  // countdown and (critically) the timer-VISIBILITY thresholds used to read
  // `timerSeconds`, which freezes when the global 1s tick stalls (tab
  // throttling, missed syncs) — so "Timer hidden until final stretch" never
  // revealed. Derive remaining time from the authoritative `timerEndsAt`
  // (clock-offset corrected) on this component's OWN 1s heartbeat, so the
  // reveal self-heals no matter what happened to the tick chain.
  const [, forceTimerTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTimerTick(t => (t + 1) % 3600), 1000);
    return () => clearInterval(id);
  }, []);
  const derivedTimerSeconds = timerEndsAt
    ? Math.max(0, Math.ceil((timerEndsAt.getTime() - (Date.now() + clockOffset)) / 1000))
    : timerSeconds;

  // T2-5 (Issue 14.2) — fetch session title so the badge above the video
  // can show event context. Pre-fix: badge said "Breakout Room · Round X/Y"
  // with no event name, leaving users unsure which event they're in.
  const [sessionTitle, setSessionTitle] = useState<string>('');
  useEffect(() => {
    if (!sessionId) return;
    api.get(`/sessions/${sessionId}`)
      .then(res => setSessionTitle(res?.data?.data?.title || ''))
      .catch(() => { /* non-fatal — badge falls back to "Breakout Room" */ });
  }, [sessionId]);

  // Backup token fetch if not provided inline
  useEffect(() => {
    if (!liveKitToken && sessionId) {
      api.post(`/sessions/${sessionId}/token`, currentRoomId ? { roomId: currentRoomId } : {}).then(res => {
        const { token, livekitUrl: url } = res.data.data;
        setLiveKitToken(token, url);
        retryCountRef.current = 0;
      }).catch(() => { /* Token fetch failed — VideoRoom will show loading state, user can leave */ });
    }
  }, [liveKitToken, sessionId, currentRoomId]);

  const handleReturnToLobby = () => {
    if (sessionId) getSocket()?.emit('participant:leave_conversation', { sessionId });
  };

  // D (25 May) — force a fresh LiveKit reconnect when the room has gone dead
  // after a suspended tab. Reuses the proven token-clear path: null token →
  // the backup fetch above pulls a fresh token → <LiveKitRoom> remounts and
  // reconnects. retryCount is reset because the user is actively back, so they
  // always get a clean attempt (rather than being kicked to lobby on an
  // exhausted budget after several drops over a long event).
  const reconnectRoom = () => {
    if (useSessionStore.getState().phase !== 'matched') return;
    retryCountRef.current = 0;
    setRetrying(true);
    setLiveKitToken(null, null);
    setTimeout(() => setRetrying(false), 1500);
  };

  if (isByeRound) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
        <div className="max-w-md w-full text-center bg-[#292a2d] rounded-2xl p-8">
          <div className="h-20 w-20 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-4">
            <Video className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">Sitting this one out</h3>
          <p className="text-gray-400 text-sm">
            You'll be matched in the next round
          </p>
          <p className="text-gray-500 text-xs mt-3">Round {currentRound} of {totalRounds}</p>
        </div>
      </div>
    );
  }

  if (!liveKitToken || !livekitUrl || retrying) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
        <div className="max-w-md w-full text-center bg-[#292a2d] rounded-2xl p-8">
          <div className="h-16 w-16 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Video className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-gray-400 text-sm">{retrying ? 'Reconnecting...' : 'Joining room...'}</p>
          <button
            onClick={handleReturnToLobby}
            className="mt-4 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Return to Main Room
          </button>
        </div>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={liveKitToken}
      serverUrl={livekitUrl}
      connect={true}
      video={true}
      audio={true}
      options={{
        videoCaptureDefaults: { resolution: { ...BG_CAPTURE_RESOLUTION } },
        // WS3/E4 — explicit echo/noise processing on the mic capture. The
        // browser defaults usually include these, but several "echo / hears
        // themselves" reports came from devices where they were off; pin
        // them on for every breakout capture.
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }}
      onConnected={() => {
        // T0-2 (Issue 7) — confirm LiveKit room membership to the server so
        // host dashboard reports real "in-breakout" presence instead of just
        // socket presence. Skipped if we don't have all 3 identifiers yet
        // (race during fast room swaps — server tolerates the gap).
        if (sessionId && currentMatchId && currentRoomId) {
          getSocket()?.emit('presence:room_joined', {
            sessionId,
            matchId: currentMatchId,
            roomId: currentRoomId,
          });
        }
        // D (25 May) — a successful (re)connect refreshes the retry budget so a
        // user who drops several times over a long event always gets a clean
        // reconnect attempt instead of being permanently bounced to the lobby.
        retryCountRef.current = 0;
      }}
      onDisconnected={() => {
        if (useSessionStore.getState().phase !== 'matched') return;
        setTimeout(() => {
          if (useSessionStore.getState().phase !== 'matched') return;
          if (retryCountRef.current < 2) {
            retryCountRef.current++;
            setRetrying(true);
            setLiveKitToken(null, null);
            setTimeout(() => setRetrying(false), 2000);
          } else {
            handleReturnToLobby();
          }
        }, 2000);
      }}
      onError={() => {
        if (useSessionStore.getState().phase !== 'matched') return;
        setTimeout(() => {
          if (useSessionStore.getState().phase !== 'matched') return;
          if (retryCountRef.current < 2) {
            retryCountRef.current++;
            setRetrying(true);
            setLiveKitToken(null, null);
            setTimeout(() => setRetrying(false), 2000);
          } else {
            handleReturnToLobby();
          }
        }, 2000);
      }}
      className="flex-1 flex flex-col"
    >
      {/* D (25 May Ali) — recover the connection (and the user's matchability +
          video) when they return to the foreground after a suspended tab. */}
      <ReconnectOnReturn onReconnect={reconnectRoom} />
      {/* WS2 — partner disconnected: passive waiting banner; the SERVER's 15s
          grace decides resume-or-end (no client-side self-eject). */}
      {partnerDisconnected && sessionId && (
        <PartnerWaitingBanner sessionId={sessionId} />
      )}
      {/* WS3/B2 — round wrap-up warning (T-30/T-10), self-dismisses after 8s.
          The 1s heartbeat above re-renders this window closed. */}
      {timerWarning && Date.now() - timerWarning.firedAt < 8000 && (
        <div className={`px-4 py-2 flex items-center justify-center gap-2 ${timerWarning.threshold <= 10 ? 'bg-red-500/10' : 'bg-amber-500/10'}`}>
          <Clock className={`h-4 w-4 ${timerWarning.threshold <= 10 ? 'text-red-400' : 'text-amber-400'}`} />
          <p className={`text-sm font-medium ${timerWarning.threshold <= 10 ? 'text-red-400' : 'text-amber-400'}`}>
            {timerWarning.threshold <= 10
              ? '10 seconds left — the round is ending'
              : '30 seconds left — time to wrap up'}
          </p>
        </div>
      )}

      <div className="flex-1 flex flex-col p-4 gap-4 bg-[#202124] overflow-auto min-h-0 relative">
        {/* Timer bar — responsive: stacks on mobile */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-[#292a2d] rounded-xl px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            {/* T2-5 (Issue 14.2) — session title prepended so users see
                event context, not just "Breakout Room" label. */}
            {sessionTitle && (
              <span className="text-xs sm:text-sm text-white font-medium truncate max-w-[180px] sm:max-w-none" title={sessionTitle}>
                {sessionTitle}
              </span>
            )}
            <span className="text-xs sm:text-sm text-gray-300 font-medium">{sessionTitle ? '·' : ''} Breakout Room</span>
            {currentRound > 0 && (
              <span className="text-xs sm:text-sm text-gray-400">Round {currentRound}/{totalRounds}</span>
            )}
            <ConnectionIndicator />
            <MediaControls />
          </div>
          {!isHost && (
            <div className="flex items-center gap-1 sm:gap-2">
              {/* WS3/G3+G4 — ONE in-room exit: "Back to Main Room" (room-only,
                  amber). Its visually-identical "Leave" twin (same ArrowLeft
                  icon, same styling — users couldn't tell them apart and some
                  left the whole EVENT meaning to leave the room) is removed;
                  the event exit lives in the top bar as the destructive
                  red "Leave Event" (LogOut icon). Its old confirm copy was
                  also wrong post-WS2 (it claimed rejoining was impossible —
                  leavers CAN rejoin; only kicks ban re-entry). */}
              <button
                onClick={() => {
                  if (confirm('Return to the main room? Your conversation will end.')) {
                    if (sessionId) getSocket()?.emit('participant:leave_conversation', { sessionId });
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-[11px] sm:text-xs font-medium text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors"
                title="End this conversation and return to the main room"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Main Room
              </button>
            </div>
          )}
          {(() => {
            // WS3/B3 — everything below reads derivedTimerSeconds (anchored
            // on timerEndsAt + this component's own 1s heartbeat) so the
            // final-stretch reveal can't stick on a frozen timerSeconds.
            // No timer if value is NaN/0 (e.g. host-created room without duration)
            if (!derivedTimerSeconds || isNaN(derivedTimerSeconds)) return null;
            // Task 14: per-room bulk breakout visibility override. Host always sees.
            if (breakoutTimerHidden && !isHost) return null;
            // Host always sees the timer regardless of visibility setting
            const showTimer = isHost ||
              timerVisibility === 'always_visible' ||
              (timerVisibility === 'last_10s' && derivedTimerSeconds <= 10) ||
              (timerVisibility === 'last_30s' && derivedTimerSeconds <= 30) ||
              (timerVisibility === 'last_60s' && derivedTimerSeconds <= 60) ||
              (timerVisibility === 'last_120s' && derivedTimerSeconds <= 120);
            if (timerVisibility === 'hidden' && !isHost) return null;
            if (!showTimer) return (
              <div className="flex items-center gap-2 text-gray-500">
                <Clock className="h-4 w-4" />
                <span className="text-sm">Timer hidden until final stretch</span>
              </div>
            );
            return (
              <div className="flex items-center gap-2 text-gray-300">
                <Clock className="h-4 w-4" />
                <span className={`font-mono text-lg ${derivedTimerSeconds <= 30 ? 'text-amber-400' : ''} ${derivedTimerSeconds <= 10 ? 'text-red-400 animate-pulse' : ''}`}>
                  {formatTime(derivedTimerSeconds)}
                </span>
                {derivedTimerSeconds <= 10 && derivedTimerSeconds > 0 && (
                  <span className="text-xs text-red-400 ml-1">Ending soon</span>
                )}
              </div>
            );
          })()}
        </div>

        {/* Video area */}
        <VideoStage />
      </div>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}
