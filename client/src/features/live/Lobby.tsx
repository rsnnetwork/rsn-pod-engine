import { Users, Loader2, Video, VideoOff, Sparkles, ChevronDown, ChevronUp, Mic, MicOff, Volume2, VolumeX, UserX, Camera, Pin, PinOff, Minimize2, Maximize2 } from 'lucide-react';
import HostRoundDashboard from './HostRoundDashboard';
import { useBgEngine } from '@/hooks/useBgEngine';
import { BackgroundPanel } from './BackgroundPanel';
import { BgCameraPublisher } from './BgCameraPublisher';
import { BG_CAPTURE_RESOLUTION } from '@/lib/backgroundEffects';
import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { useSessionStore, useInRoomParticipants } from '@/stores/sessionStore';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';
import { useVisibilityPartition } from './useVisibilityPartition';
import { computeTileWindow } from './tileWindow';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useParticipants,
  useLocalParticipant,
  RoomAudioRenderer,
  useConnectionState,
  useRoomContext,
} from '@livekit/components-react';
import { isTrackReference } from '@livekit/components-core';
import '@livekit/components-styles';
import { Track, ConnectionState, RoomEvent, VideoPresets } from 'livekit-client';

// Bug 10 (April 19) — Meet/Zoom-style reaction badge anchored above
// the lobby tile name plate. Subscribes only to this user's entry so
// other tiles don't re-render when someone reacts.
const LobbyTileReaction = memo(function LobbyTileReaction({ userId }: { userId?: string }) {
  const reaction = useSessionStore(s => userId ? s.tileReactions[userId] : undefined);
  if (!reaction) return null;
  return (
    <div className="absolute bottom-9 left-1.5 flex items-center gap-1 bg-black/80 text-white rounded-full px-2 py-0.5 shadow-lg animate-fade-in pointer-events-none z-20">
      <span className="text-base leading-none">{reaction.emoji}</span>
      <span className="text-[10px] font-medium truncate max-w-[120px]">{reaction.displayName}</span>
    </div>
  );
});

function LobbyMosaic({ isHost, sessionId }: { isHost: boolean; sessionId?: string }) {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  // UX2 (June-10 debrief) — a remote tile's mic/cam icon could show the wrong
  // state because the mosaic didn't re-render when a REMOTE participant toggled
  // their track (renderTile reads participant.isMicrophoneEnabled at render
  // time, but useTracks/useParticipants don't re-run on a remote mute/unmute).
  // Force a re-render on the room's mute events so the icon always reflects the
  // live LiveKit track state. (The local tile was already reactive via
  // useLocalParticipant — Bug 11.)
  const room = useRoomContext();
  const [, setMuteTick] = useState(0);
  useEffect(() => {
    if (!room) return;
    const bump = () => setMuteTick(t => t + 1);
    // Mute/unmute drives the mic icon; subscribe/unsubscribe drives whether a
    // remote camera tile shows video vs the "camera off" placeholder, which
    // could lag behind reality on a slow subscribe.
    room.on(RoomEvent.TrackMuted, bump)
      .on(RoomEvent.TrackUnmuted, bump)
      .on(RoomEvent.TrackSubscribed, bump)
      .on(RoomEvent.TrackUnsubscribed, bump);
    return () => {
      room.off(RoomEvent.TrackMuted, bump)
        .off(RoomEvent.TrackUnmuted, bump)
        .off(RoomEvent.TrackSubscribed, bump)
        .off(RoomEvent.TrackUnsubscribed, bump);
    };
  }, [room]);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const lobbyDensity = useSessionStore(s => s.lobbyDensity);
  // VID-2 (audit C2) — cap rendered tiles by density × viewport. 639px aligns
  // with the Tailwind `sm:` breakpoint the grid classes already use.
  const isMobile = useMediaQuery('(max-width: 639px)');
  // Phase N (12 May spec item 2) — host visibility mode per host/cohost.
  // Read from the server-authoritative store; the 4 modes drive how each
  // hostly user is rendered in the lobby (and breakout) grid.
  const hostVisibilityModes = useSessionStore(s => s.hostVisibilityModes);
  // Phase Q (12 May spec item 2 — Ali's clarification): hosts get bigger
  // tiles automatically (not "self" — that was the wrong pre-Phase-Q
  // behaviour). Build the acting-host set from director + cohorts +
  // opt-ins minus opt-outs; the director is always counted regardless
  // of any stale row. Same shape as HostParticipantPanel uses.
  const cohosts = useSessionStore(s => s.cohosts);
  const actingAsHostOverrides = useSessionStore(s => s.actingAsHostOverrides);
  const hostsSet = (() => {
    const s = new Set<string>();
    if (hostUserId) s.add(hostUserId);
    for (const c of cohosts) s.add(c);
    for (const [uid, v] of Object.entries(actingAsHostOverrides)) {
      if (v === true) s.add(uid);
      if (v === false) s.delete(uid);
    }
    if (hostUserId) s.add(hostUserId);
    return s;
  })();
  const cameraTracksRaw = tracks.filter(t => t.source === Track.Source.Camera);

  // Phase Q sort order: director first, then other acting hosts (cohorts
  // + opt-ins), then the local user, then everyone else. This guarantees
  // the #1 tile in the grid is ALWAYS the director's, regardless of
  // viewer — matching Ali's 13 May clarification on Stefan's spec.
  const cameraTracksSorted = [...cameraTracksRaw].sort((a, b) => {
    const aId = a.participant.identity;
    const bId = b.participant.identity;
    const aIsDirector = aId === hostUserId;
    const bIsDirector = bId === hostUserId;
    if (aIsDirector && !bIsDirector) return -1;
    if (!aIsDirector && bIsDirector) return 1;
    const aIsHost = !!aId && hostsSet.has(aId);
    const bIsHost = !!bId && hostsSet.has(bId);
    if (aIsHost && !bIsHost) return -1;
    if (!aIsHost && bIsHost) return 1;
    const aIsLocal = a.participant.sid === localParticipant.sid ? 0 : 1;
    const bIsLocal = b.participant.sid === localParticipant.sid ? 0 : 1;
    return aIsLocal - bIsLocal;
  });

  // Phase N + T — partition tracks by visibility mode via shared hook.
  // Hidden users are dropped entirely; producers go to an audio-only
  // strip; big_speakers get a dedicated stage row; everyone else
  // (default 'normal') lands in the main grid. The hook is also used
  // by VideoRoom for breakouts (Phase T).
  const {
    bigSpeakerTracks,
    producerTracks,
    normalTracks: cameraTracks,
    visibilityFor,
  } = useVisibilityPartition(cameraTracksSorted, hostVisibilityModes);

  // S21 (live-test z1, 12 browsers) — when OUR OWN connection renegotiates,
  // every remote track vanishes for 2–4s and the grid flashed to a single
  // tile ("0 participants + 1 host"). During reconnect we freeze the LAST
  // GOOD roster as placeholder tiles with an explicit "Reconnecting…" badge
  // — never a stale list presented as live. Hard cap 15s, then we fall back
  // to whatever the room reports (plus the badge) rather than hold forever.
  // Normal operation is untouched: joins/leaves apply instantly.
  const connectionState = useConnectionState();
  const reconnecting = connectionState !== ConnectionState.Connected;
  const heldRosterRef = useRef<Array<{ identity: string; name: string }>>([]);
  const holdDeadlineRef = useRef(0);
  const [, setHoldTick] = useState(0);
  if (!reconnecting) {
    holdDeadlineRef.current = 0;
    if (cameraTracksSorted.length > 1) {
      heldRosterRef.current = cameraTracksSorted.map(t => ({
        identity: t.participant.identity,
        name: t.participant.name || 'Participant',
      }));
    }
  } else if (holdDeadlineRef.current === 0 && heldRosterRef.current.length > 1) {
    holdDeadlineRef.current = Date.now() + 15_000;
  }
  const holdActive = reconnecting && holdDeadlineRef.current > 0 && Date.now() < holdDeadlineRef.current;
  useEffect(() => {
    if (!holdActive) return;
    // Re-render at the cap so an unrecovered connection stops holding.
    const t = setTimeout(() => setHoldTick(x => x + 1), Math.max(0, holdDeadlineRef.current - Date.now()) + 100);
    return () => clearTimeout(t);
  }, [holdActive]);

  // Responsive grid based on density preference
  const n = participants.length;
  // Bug 8 (18 May Stefan) + Bug 49 (19 May Stefan) — three densities must be
  // VISUALLY distinct on mobile, not just on desktop. Stefan flagged 19 May
  // that normal and spacious looked "almost the same" on a phone — root
  // cause: at n=2 (the most common test case) both rendered grid-cols-1 on
  // mobile, identical layout. Now:
  //   - compact:  3 cols (smallest tiles, tightest gap, info-dense)
  //   - normal:   2 cols on mobile when n>=2 (so n=2 is side-by-side, not
  //               one giant column tile that looks the same as spacious)
  //   - spacious: 1 col with extra horizontal padding so the tile is
  //               framed away from the screen edges (max-w-md auto-mx),
  //               making the difference unmistakable vs normal at every n.
  const gridCols = lobbyDensity === 'compact'
    ? (n <= 4 ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-3 sm:grid-cols-5 lg:grid-cols-6')
    : lobbyDensity === 'spacious'
    ? 'grid-cols-1'
    : // normal (default) — always at least 2 cols on mobile from n=2 up so
      // it's distinct from spacious (which stays 1 col with framing).
      n <= 1 ? 'grid-cols-1'
      : n <= 4 ? 'grid-cols-2 sm:grid-cols-2'
      : n <= 9 ? 'grid-cols-2 sm:grid-cols-3'
      : 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-5';
  const gapClass = lobbyDensity === 'compact' ? 'gap-1.5' : lobbyDensity === 'spacious' ? 'gap-6' : 'gap-3';
  // Bug 49 — spacious mode on mobile needs an inner cap + auto-margins so
  // the 1-col tile is visibly framed (not edge-to-edge identical to normal
  // at n=2). max-w-md (~28rem / 448px) is wider than 360-414px mobile
  // viewports so the tile is constrained by viewport minus horizontal
  // padding on mobile, and centred with breathing room on tablet+.
  const maxWClass = lobbyDensity === 'compact'
    ? 'max-w-5xl'
    : lobbyDensity === 'spacious'
    ? 'max-w-md sm:max-w-2xl px-4 sm:px-0'
    : 'max-w-4xl';

  const handleHostMute = useCallback((targetIdentity: string, mute: boolean) => {
    if (!sessionId) return;
    const socket = getSocket();
    socket?.emit('host:mute_participant', { sessionId, targetUserId: targetIdentity, muted: mute });
  }, [sessionId]);

  const handleKick = useCallback((targetIdentity: string, targetName: string) => {
    if (!sessionId) return;
    if (!window.confirm(`Remove ${targetName} from this event?`)) return;
    const socket = getSocket();
    socket?.emit('host:remove_participant', { sessionId, userId: targetIdentity, reason: 'Removed by host' });
  }, [sessionId]);

  // F2 (20 May 2026 — user spec): host can shrink a cohost's tile back to
  // participant size without opening HCC. Visual only; cohost privileges
  // (mute-others, HCC access, etc.) are unchanged. Same handler the HCC
  // "Small tile / Restore tile" button calls — server-side handler at
  // host-actions.ts:handleSetTileSize verifies the caller is the actual
  // event director.
  const handleSetTileSize = useCallback(
    (targetIdentity: string, size: 'participant' | 'host') => {
      if (!sessionId) return;
      const socket = getSocket();
      socket?.emit('host:set_tile_size', {
        sessionId,
        targetUserId: targetIdentity,
        size,
      });
    },
    [sessionId],
  );

  // Pin/spotlight state — client-side only, no server interaction
  const [pinnedSid, setPinnedSid] = useState<string | null>(null);

  // Bug 1 (18 May Stefan) — global pin set by an acting host on the
  // server. When non-null, this overrides every viewer's local pin: the
  // named user becomes the big tile for everyone. The server pin is
  // userId-based (canonical), so we resolve it to a LiveKit sid here.
  const serverPinnedUserId = useSessionStore(s => s.serverPinnedUserId);
  // Bug 26 (19 May Ali) — director's visual demote list. Cohosts whose
  // userId appears here render at participant tile size even though
  // hostsSet still contains them (privileges unchanged).
  //
  // CRITICAL — read the raw array from Zustand (stable identity until the
  // array itself changes), then memoise the Set. The earlier shape
  // `useSessionStore(s => new Set(s.tileDemotedUserIds))` returned a fresh
  // Set on every selector call; Zustand's default Object.is equality saw
  // a "new" value every render and triggered another render in a loop,
  // which surfaced in production as React error #185 ("Maximum update
  // depth exceeded") and crashed the live Lobby behind an error boundary.
  const tileDemotedUserIds = useSessionStore(s => s.tileDemotedUserIds);
  const tileDemotedSet = useMemo(() => new Set(tileDemotedUserIds), [tileDemotedUserIds]);
  const serverPinnedSid = (() => {
    if (!serverPinnedUserId) return null;
    const t = cameraTracksSorted.find(
      tr => tr.participant.identity === serverPinnedUserId,
    );
    return t?.participant.sid ?? null;
  })();
  // Effective pin: server wins when set, otherwise per-viewer local pin.
  // The renderer + button-click handlers read this single value so the
  // two code paths can't drift.
  const effectivePinnedSid = serverPinnedSid ?? pinnedSid;

  // setEffectivePin handles both branches in one place:
  //   - Acting host viewer → call host:set_pin (global broadcast)
  //   - Participant viewer → fall back to per-viewer local pin
  // Mapping back from sid → userId for the server uses the LiveKit
  // participant identity (which IS the userId by our token convention).
  const setEffectivePin = useCallback(
    (sid: string | null) => {
      if (isHost && sessionId) {
        // Global. Find the userId from the sid (or pass null to clear).
        let targetUserId: string | null = null;
        if (sid) {
          const t = cameraTracksSorted.find(tr => tr.participant.sid === sid);
          targetUserId = t?.participant.identity ?? null;
        }
        const socket = getSocket();
        socket?.emit('host:set_pin', { sessionId, pinnedUserId: targetUserId });
        // Server will fan out pin:changed to us too; no optimistic local
        // write needed. Keeping the local-pin slot null avoids confusion
        // if the host later loses host role mid-event.
        setPinnedSid(null);
      } else {
        // Local-only — yesterday's behaviour preserved for participants.
        setPinnedSid(sid);
      }
    },
    [isHost, cameraTracksSorted, sessionId],
  );

  // Auto-unpin if pinned participant leaves OR if their visibility mode
  // is now 'hidden' (Phase N — host can hide themselves mid-event; a
  // pinned-then-hidden user would otherwise leak as the big tile). Only
  // clears the local pin — the server pin is host-managed and self-
  // recovers via the server-side cleanup on participant removal.
  useEffect(() => {
    if (!pinnedSid) return;
    const pinned = cameraTracksSorted.find(t => t.participant.sid === pinnedSid);
    if (!pinned) {
      setPinnedSid(null);
      return;
    }
    if (visibilityFor(pinned) === 'hidden') {
      setPinnedSid(null);
    }
  }, [cameraTracksSorted, pinnedSid, visibilityFor]);

  // Issue 12 (21 May Stefan re-test) — "Host tiles must REMAIN LARGER
  // than other participants, and also sit next to each other." Phase Q's
  // col-span-2 row-span-2 worked at compact density (4+ cols → two hosts
  // at col-span-2 each fit side-by-side in row 1) but collapsed at
  // normal density (2 cols → col-span-2 = full row, so two hosts
  // stacked). The first attempted fix (cc09a19) dropped multi-host
  // tiles to `aspect-video` (same size as participants), which Stefan
  // re-flagged as wrong: hosts must stay visually bigger even when
  // there are two or three of them.
  //
  // Final shape:
  //   • 1 host in any density        → col-span-2 row-span-2 (hero / Phase Q)
  //   • 2+ hosts in compact density  → col-span-2 row-span-2 (works there
  //                                    because the grid is ≥4 cols, so
  //                                    two col-span-2 tiles share row 1)
  //   • 2+ hosts in narrow density   → col-span-1 with `aspect-[4/3]`
  //     (normal + spacious — 2-col)    instead of aspect-video. Same width
  //                                    as a participant tile but ~1.33×
  //                                    taller, so hosts remain visibly
  //                                    bigger AND adjacent in row 1.
  const actingHostCountInGrid = cameraTracks.reduce((count, t) => {
    const id = t.participant.identity;
    return id && hostsSet.has(id) && !tileDemotedSet.has(id) ? count + 1 : count;
  }, 0);
  const narrowGrid = lobbyDensity === 'normal' || lobbyDensity === 'spacious';
  const useBigHostTiles = actingHostCountInGrid <= 1 || !narrowGrid;
  // Multi-host narrow-grid path — taller-than-participant aspect ratio
  // keeps the visual hierarchy while col-span-1 lets them sit adjacent.
  const multiHostNarrowTileClass = 'aspect-[4/3] col-span-1 row-span-1 ring-2 ring-rsn-red/30';
  const soloOrCompactHostTileClass = 'aspect-video col-span-2 row-span-2 ring-2 ring-rsn-red/30';

  // Helper to render a single video tile with all overlays
  const renderTile = (trackRef: any, { isPinned = false, onClick }: { isPinned?: boolean; onClick?: () => void } = {}) => {
    const name = trackRef.participant.name || trackRef.participant.identity || 'User';
    // UX2 (June-10 debrief) — camera "on" means a published video track that is
    // NOT muted. Turning a camera off MUTES the track (it stays published), so
    // checking track-presence alone left a muted (off) camera showing as on.
    const hasVideo = !!trackRef.publication?.track && !trackRef.publication?.isMuted;
    const isLocal = trackRef.participant.sid === localParticipant.sid;
    const tileIsHost = trackRef.participant.identity === hostUserId;
    // Phase Q (12 May spec item 2 — Ali's 13 May clarification) — hosts
    // get the bigger tile automatically. Pre-Phase-Q this was tied to
    // `isLocal` (Phase 8C.2 self-prominence rule), which made each user
    // see THEMSELVES as the big tile regardless of role — exactly the
    // behaviour Stefan called out in the 12 May test. Now the elevation
    // follows the host roster (director + cohosts + opt-ins), so every
    // viewer sees the host(s) as the big tile(s) and #1 is always the
    // director.
    // Bug 26 (19 May Ali) — if the director has demoted this cohost's
    // tile, we strip the host-tile treatment here while keeping every
    // server-side privilege intact (mute-others, HCC, etc. still work).
    const isActingHost = !!trackRef.participant.identity
      && hostsSet.has(trackRef.participant.identity)
      && !tileDemotedSet.has(trackRef.participant.identity);
    const isMicOn = trackRef.participant.isMicrophoneEnabled;
    return (
      <div
        key={trackRef.participant.sid}
        data-self={isLocal ? 'true' : undefined}
        data-host={tileIsHost ? 'true' : undefined}
        data-acting-host={isActingHost ? 'true' : undefined}
        className={`relative rounded-xl overflow-hidden bg-[#3c4043] ${isPinned ? 'h-full w-full' : isActingHost ? (useBigHostTiles ? soloOrCompactHostTileClass : multiHostNarrowTileClass) : 'aspect-video'} flex items-center justify-center group cursor-pointer [content-visibility:auto] [contain-intrinsic-size:auto_200px]`}
        onClick={onClick}
      >
        {hasVideo && isTrackReference(trackRef) ? (
          // T2-1 (Issue 13.1) — main-room camera too zoomed bug. Lobby
          // unconditionally used object-cover which crops a portrait phone
          // camera to fill a 16:9 landscape tile, exaggerating the face
          // (this was the "main room camera too zoomed" the review reported).
          // Now matches VideoRoom's behaviour: object-contain by default
          // for the full frame, object-cover only when explicitly pinned
          // (PIP-style). Wrapper class .rsn-tile-contain enforces the
          // override against LiveKit's vendor stylesheet specificity.
          <div className={`h-full w-full ${isPinned ? '' : 'rsn-tile-contain'}`}>
            <VideoTrack trackRef={trackRef} className={`h-full w-full ${isPinned ? 'object-cover' : 'object-contain'}`} />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className={`${isPinned ? 'h-20 w-20' : 'h-14 w-14'} rounded-full bg-[#5f6368] flex items-center justify-center text-white font-semibold text-xl`}>
              {name.charAt(0).toUpperCase()}
            </div>
          </div>
        )}
        {/* Name + controls: stacked on local tile to prevent overlap.
            Bug 12 (13 May live test) — Phase M opt-in admins got the bigger
            tile (Phase Q) but no badge. Now: director keeps (Host) in amber,
            anyone else in hostsSet shows (Co-Host) in indigo. Mirrors the
            ParticipantList badge styling so the role is obvious wherever
            you look. */}
        {isLocal ? (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-col items-start gap-1" onClick={e => e.stopPropagation()}>
            <div className="bg-black/60 backdrop-blur-sm rounded px-2 py-0.5 text-[11px] text-white truncate max-w-[90%] flex items-center gap-1.5">
              {name}
              {tileIsHost ? (
                <span className="text-[9px] font-medium text-amber-300 ml-0.5">(Host)</span>
              ) : isActingHost ? (
                <span className="text-[9px] font-medium text-indigo-300 ml-0.5">(Co-Host)</span>
              ) : null}
            </div>
            <LobbyMediaControls isHost={isHost} sessionId={sessionId} />
          </div>
        ) : (
          <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-sm rounded px-2 py-0.5 text-[11px] text-white truncate max-w-[90%] flex items-center gap-1.5">
            {name}
            {tileIsHost ? (
              <span className="text-[9px] font-medium text-amber-300 ml-0.5">(Host)</span>
            ) : isActingHost ? (
              <span className="text-[9px] font-medium text-indigo-300 ml-0.5">(Co-Host)</span>
            ) : null}
          </div>
        )}
        {/* Bug 1 (18 May Stefan) — explicit pin / unpin button on every
            tile. Click semantics depend on viewer role:
              - Acting host  → emits host:set_pin (broadcast to all
                participants; server fans out pin:changed).
              - Participant  → toggles local-only pin (per-viewer).
            setEffectivePin routes either path; the visible button label
            stays "Pin / Unpin" for both. The amber ring on the active
            pin uses the EFFECTIVE pinned sid (whichever path set it)
            so the button correctly reflects what the viewer sees. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEffectivePin(isPinned ? null : trackRef.participant.sid);
          }}
          title={isPinned ? `Unpin ${name}` : `Pin ${name} as spotlight`}
          aria-label={isPinned ? `Unpin ${name}` : `Pin ${name}`}
          data-testid={isPinned ? 'tile-unpin-button' : 'tile-pin-button'}
          className={`absolute ${isLocal ? 'top-1.5' : 'top-1.5'} right-1.5 z-10 bg-black/55 hover:bg-black/75 backdrop-blur-sm rounded-full p-1.5 text-white transition-colors ${isPinned ? 'ring-1 ring-amber-300/70 text-amber-200' : ''}`}
        >
          {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        {/* Issue 13 (20 May Stefan) — "Host should be able to unpin."
            The director can shrink their OWN tile back to participant
            size (and restore it later) directly from their tile. Visual
            only — every director privilege is unchanged. Visible only
            to the director themselves on their own tile, so cohosts and
            participants don't see a control they can't actuate. */}
        {isHost && isLocal && tileIsHost && (
          <div className="absolute top-1.5 right-10 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            {tileDemotedSet.has(trackRef.participant.identity) ? (
              <button
                onClick={() => handleSetTileSize(trackRef.participant.identity, 'host')}
                className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-indigo-600/70"
                title="Restore your tile to host size"
                aria-label="Restore your tile"
                data-testid="tile-self-restore-button"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                onClick={() => handleSetTileSize(trackRef.participant.identity, 'participant')}
                className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-black/70"
                title="Shrink your tile to participant size (privileges unchanged)"
                aria-label="Shrink your tile"
                data-testid="tile-self-shrink-button"
              >
                <Minimize2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        {/* Host mute/unmute + kick buttons on remote participant tiles.
            18 May — shifted left to right-10 so the always-visible pin
            button (right-1.5) doesn't get covered when the host hovers.
            F2 (20 May 2026) — when the target is a cohost (acting host
            other than the director), the director also gets a Small
            tile / Restore tile toggle directly on the tile, mirroring
            the HCC button. Cohost keeps all privileges; only visual. */}
        {isHost && !isLocal && (
          <div className="absolute top-1.5 right-10 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            {trackRef.participant.identity
              && hostsSet.has(trackRef.participant.identity)
              && trackRef.participant.identity !== hostUserId && (
                tileDemotedSet.has(trackRef.participant.identity) ? (
                  <button
                    onClick={() => handleSetTileSize(trackRef.participant.identity, 'host')}
                    className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-indigo-600/70"
                    title={`Restore ${name}'s tile to host size`}
                    aria-label={`Restore ${name}'s tile`}
                    data-testid="tile-restore-button"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() => handleSetTileSize(trackRef.participant.identity, 'participant')}
                    className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-black/70"
                    title={`Shrink ${name}'s tile to participant size (privileges unchanged)`}
                    aria-label={`Shrink ${name}'s tile`}
                    data-testid="tile-shrink-button"
                  >
                    <Minimize2 className="h-3.5 w-3.5" />
                  </button>
                )
              )}
            <button
              onClick={() => handleHostMute(trackRef.participant.identity, !!isMicOn)}
              className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-black/70"
              title={isMicOn ? `Mute ${name}` : `Unmute ${name}`}
            >
              {isMicOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5 text-red-400" />}
            </button>
            <button
              onClick={() => handleKick(trackRef.participant.identity, name)}
              className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-red-600/70"
              title={`Remove ${name}`}
            >
              <UserX className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* Mic status indicator. Bug 10 (18 May Stefan) — hidden on the
            local tile because LobbyMediaControls already renders an
            explicit Mic Off / Cam Off button right below the name; the
            duplicate icon at top-left + the labeled button at bottom-left
            is what Claus called "duplicated mute/camera indicators". For
            remote tiles the top-left icon is still the only mic signal
            so it stays. */}
        {!isMicOn && !isLocal && (
          <div className="absolute top-2 left-2 bg-red-500/90 rounded-full p-1">
            <MicOff className="h-2.5 w-2.5 text-[#1a1a2e]" />
          </div>
        )}
        {/* Bug 10 (April 19) — anchored reaction badge above the name plate. */}
        <LobbyTileReaction userId={trackRef.participant.identity} />
      </div>
    );
  };

  // S21 — held grid while reconnecting: same layout, placeholder tiles
  // (avatar initial + name) from the last good roster, with the badge.
  // Rendered INSTEAD of live tiles (no stale interactive controls, no
  // dead video elements).
  if (holdActive) {
    return (
      <div className={`relative flex flex-col gap-3 w-full ${maxWClass} mx-auto`} data-testid="lobby-reconnect-hold">
        <div className="flex justify-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-500 text-white text-xs font-semibold px-3 py-1.5 shadow">
            <Loader2 className="h-3 w-3 animate-spin" /> Reconnecting…
          </span>
        </div>
        <div className={`grid ${gridCols} ${gapClass} opacity-80`}>
          {heldRosterRef.current.map(p => (
            <div key={p.identity} className="relative aspect-video rounded-xl bg-gray-900 flex items-center justify-center">
              <div className="flex flex-col items-center gap-1.5">
                <div className="h-10 w-10 rounded-full bg-gray-700 text-white flex items-center justify-center text-sm font-semibold">
                  {(p.name || '?').charAt(0).toUpperCase()}
                </div>
                <span className="text-xs text-gray-300 max-w-[90%] truncate">{p.name}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Pinned layout: large tile + small row at bottom.
  // Bug 1 (18 May Stefan) — render against EFFECTIVE pin (server > local)
  // so a host's global pin shows the same big tile to every participant.
  // The pinned-mode strip includes big_speaker and producer tracks (no
  // dedicated stage/audio rows render in this layout); hidden tracks
  // stay filtered out everywhere.
  const pinnedTrack = effectivePinnedSid
    ? cameraTracksSorted.find(t => t.participant.sid === effectivePinnedSid)
    : null;
  if (pinnedTrack) {
    const unpinnedTracks = cameraTracksSorted.filter(
      t => t.participant.sid !== effectivePinnedSid && visibilityFor(t) !== 'hidden',
    );
    // VID-2 — cap the thumbnail strip too; the remainder collapses to a "+N" pill.
    const { visible: stripTracks, overflowCount: stripOverflow } = computeTileWindow({
      tracks: unpinnedTracks, density: lobbyDensity, isMobile,
      localSid: localParticipant.sid, sidOf: (t: any) => t.participant.sid,
    });
    return (
      <div className={`flex flex-col gap-3 w-full ${maxWClass} mx-auto h-full`}>
        <div className="flex-1 min-h-0">
          {renderTile(pinnedTrack, { isPinned: true, onClick: () => setEffectivePin(null) })}
        </div>
        {unpinnedTracks.length > 0 && (
          <div className="flex gap-2 h-24 shrink-0 overflow-x-auto">
            {stripTracks.map(t => (
              <div key={t.participant.sid} className="flex-shrink-0 w-32">
                {renderTile(t, { onClick: () => setEffectivePin(t.participant.sid) })}
              </div>
            ))}
            {stripOverflow > 0 && (
              <div className="flex-shrink-0 w-20 rounded-xl bg-[#3c4043] flex flex-col items-center justify-center text-gray-300 [content-visibility:auto]">
                <span className="text-sm font-semibold">+{stripOverflow}</span>
                <span className="text-[9px] text-gray-500">audio still on</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Default layout (no pin) — Phase N stacks three sections:
  //   1. Big-speaker stage row (above the grid, only if any big_speaker
  //      hosts exist). One tile per big_speaker, full-width row.
  //   2. Main grid — all 'normal' tracks (default for non-hosts and
  //      hosts without a chosen mode).
  //   3. Producer strip (below the grid, only if any producers exist).
  //      Pills with name + audio icon; no video tile.
  // Hidden hosts/cohosts are filtered out entirely.
  // VID-2 — cap the main grid by density × viewport; the rest become "+N more".
  const { visible: gridTracks, overflowCount } = computeTileWindow({
    tracks: cameraTracks, density: lobbyDensity, isMobile,
    localSid: localParticipant.sid, sidOf: (t: any) => t.participant.sid,
  });
  return (
    <div className={`flex flex-col gap-3 w-full ${maxWClass} mx-auto`}>
      {bigSpeakerTracks.length > 0 && (
        <div
          data-testid="lobby-big-speaker-stage"
          className={`grid gap-3 ${
            bigSpeakerTracks.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'
          }`}
        >
          {bigSpeakerTracks.map(trackRef =>
            renderTile(trackRef, {
              isPinned: true,
              onClick: () => setEffectivePin(trackRef.participant.sid),
            }),
          )}
        </div>
      )}
      <div className={`grid ${gridCols} ${gapClass} w-full`}>
        {gridTracks.map(trackRef =>
          renderTile(trackRef, { onClick: () => setEffectivePin(trackRef.participant.sid) })
        )}
        {overflowCount > 0 && (
          <div
            data-testid="lobby-overflow-tile"
            className="relative rounded-xl bg-[#3c4043] aspect-video flex flex-col items-center justify-center text-gray-300 [content-visibility:auto]"
          >
            <Users className="h-6 w-6 mb-1" />
            <span className="text-sm font-semibold">+{overflowCount} more</span>
            <span className="text-[10px] text-gray-500">audio still on</span>
          </div>
        )}
        {cameraTracks.length === 0 && bigSpeakerTracks.length === 0 && (
          <div className="col-span-full text-center py-12 text-gray-500 text-sm">
            <div className="h-16 w-16 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-3">
              <VideoOff className="h-6 w-6 text-gray-400" />
            </div>
            Waiting for participants to enable cameras...
          </div>
        )}
      </div>
      {producerTracks.length > 0 && (
        <div
          data-testid="lobby-producer-strip"
          className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-[#1f2024] border border-[#3c4043]"
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
              <Mic className="h-3 w-3 text-gray-300" />
              {t.participant.name || t.participant.identity || 'Producer'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// WS3/E5+E6 — module-scope marker: which LiveKit participant SIDs already
// had their join preferences (auto-mute + camera pref) applied. Survives
// the flex↔grid remounts that a pin/density change causes; a NEW room
// connection gets a new SID and re-applies. Bounded: a tab accumulates a
// handful of SIDs per event at most.
const appliedPrefsForSid = new Set<string>();

/** P2-3 — prune on event exit (LiveSessionPage unmount). SIDs are never
 *  reused, so entries from a finished event are dead weight; without this a
 *  long-lived tab hopping between events grows the set forever. */
export function clearAppliedPrefMarkers(): void {
  appliedPrefsForSid.clear();
}

function LobbyMediaControls({ isHost, sessionId }: { isHost: boolean; sessionId?: string }) {
  // Bug 11 (13 May live test) — destructure the reactive isMicrophoneEnabled /
  // isCameraEnabled values from useLocalParticipant directly. Pre-fix the
  // component relied on manual `localParticipant.on('trackPublished', ...)`
  // listeners + a stale React state mirror, but in livekit-client v2 the
  // LocalParticipant emits `localTrackPublished` (not `trackPublished`) for
  // its own publishes, so the listener never fired and the React state drifted
  // out of sync with reality — "Cam Off" appeared while the camera was clearly
  // publishing video. The components-react hook subscribes to the right event
  // matrix internally, so we use those values as the source of truth and only
  // mirror them into local state for the optimistic-toggle UX.
  const { localParticipant, isMicrophoneEnabled: hookMicEnabled, isCameraEnabled: hookCamEnabled } = useLocalParticipant();
  const allParticipants = useParticipants();
  // P2-1 — field selectors, not whole-store: this strip must not re-render on
  // every timer tick / chat message (it sits inside the per-tile layout).
  const hostMuteCommand = useSessionStore(s => s.hostMuteCommand);
  const setHostMuteCommand = useSessionStore(s => s.setHostMuteCommand);
  // Restore camera/mic preference from sessionStorage (FIX 15D — survives refresh)
  const [micEnabled, setMicEnabled] = useState(() => {
    const saved = sessionStorage.getItem('rsn_mic');
    return saved !== null ? saved === 'true' : isHost;
  });
  const [camEnabled, setCamEnabled] = useState(() => {
    const saved = sessionStorage.getItem('rsn_cam');
    return saved !== null ? saved === 'true' : true;
  });
  // Issue 10 — restore last bg choice for the UI highlight. The actual
  // processor is (re-)applied by a separate effect once the local camera
  // track is ready.
  const [showBgPanel, setShowBgPanel] = useState(false);
  // Event-scoped BG engine (lib/bgEngine): ONE camera track + ONE pipeline for
  // the whole event, published into every room — applies are instant switchTo()s
  // and the background persists structurally across main↔breakout↔manual.
  const bg = useBgEngine();

  // Derive allMuted from actual remote participant mic state (host button label
  // must reflect reality, not a stale local flag that resets on remount).
  const allMuted = (() => {
    const remotes = allParticipants.filter(p => p.sid !== localParticipant?.sid);
    if (remotes.length === 0) return false;
    return remotes.every(p => !p.isMicrophoneEnabled);
  })();

  // Apply saved camera/mic preferences to LiveKit ONCE PER ROOM CONNECTION.
  //
  // WS3/E5+E6 — this used to be guarded by a per-INSTANCE useRef. The pin /
  // tile-demote / density features swap the lobby between flex and grid
  // trees, which REMOUNTS LobbyMediaControls — fresh ref → the non-host
  // auto-mute block (plus its 500ms re-apply) re-fired on every layout
  // change, force-muting anyone who had unmuted. That was the real "I
  // unmute and it flips back / nobody can hear me in the main room" bug.
  // The guard is now keyed on the LiveKit participant SID (module scope):
  // one application per actual room connection — remounts are no-ops, while
  // a genuine rejoin / room change gets a fresh SID and re-applies the
  // join-muted policy as designed.
  useEffect(() => {
    if (!localParticipant) return;
    const sid = localParticipant.sid;
    if (!sid || appliedPrefsForSid.has(sid)) return;
    appliedPrefsForSid.add(sid);

    // Camera preference is applied by BgCameraPublisher BEFORE the engine track
    // publishes (no flash of video for camera-off users); here we only mirror.
    setCamEnabled(localParticipant.isCameraEnabled);

    // Mic: auto-mute participants on first join / return from breakout.
    // Double-apply after 500ms to beat any LiveKit race where audio is auto-published
    // shortly after the local participant becomes available.
    if (!isHost) {
      localParticipant.setMicrophoneEnabled(false).catch(() => {});
      setMicEnabled(false);
      sessionStorage.setItem('rsn_mic', 'false');
      const t = setTimeout(() => {
        localParticipant.setMicrophoneEnabled(false).catch(() => {});
      }, 500);
      return () => clearTimeout(t);
    } else {
      const savedMic = sessionStorage.getItem('rsn_mic');
      if (savedMic !== null) {
        const wantMic = savedMic === 'true';
        localParticipant.setMicrophoneEnabled(wantMic).catch(() => {});
        setMicEnabled(wantMic);
      }
    }
  }, [localParticipant, isHost]);

  // (Background persistence across main↔breakout is structural: the event-
  // scoped engine track — pipeline attached — is republished into every room
  // by BgCameraPublisher. Nothing to re-apply here.)

  // Bug 11 (13 May live test) — sync local optimistic state with the hook's
  // reactive values. The hook re-renders the parent whenever the underlying
  // track state changes (any source: user toggle, host mute, network
  // reconnect, server-side permission update). This replaces the manual
  // `localParticipant.on('trackPublished', ...)` listeners that were silent
  // for LocalParticipant in livekit-client v2 (it emits `localTrackPublished`
  // not `trackPublished` for self publishes).
  useEffect(() => {
    setMicEnabled(hookMicEnabled);
  }, [hookMicEnabled]);
  useEffect(() => {
    setCamEnabled(hookCamEnabled);
  }, [hookCamEnabled]);

  // Guard: prevent user toggle while host mute command is being applied (race condition)
  const [hostMuteProcessing, setHostMuteProcessing] = useState(false);

  // Respond to host mute/unmute commands — takes priority over local toggle
  useEffect(() => {
    if (hostMuteCommand !== null && !isHost) {
      setHostMuteProcessing(true);
      const target = !hostMuteCommand; // hostMuteCommand=true means "mute", so !true = false = mute
      // S17 (live-test 2026-06-06) — the publish used to be fire-and-forget
      // with no catch: when the host's UNMUTE relay raced ahead of the
      // LiveKit permission restore, setMicrophoneEnabled(true) threw
      // PublishTrackError "insufficient permissions" and the user stayed
      // visibly muted (Ali: "host unmutes all but the tile shows mute").
      // The server now restores the permission BEFORE relaying; this retry
      // covers any residual SFU propagation delay.
      void (async () => {
        try {
          await localParticipant.setMicrophoneEnabled(target);
        } catch {
          await new Promise((r) => setTimeout(r, 1200));
          await localParticipant.setMicrophoneEnabled(target).catch(() => {});
        }
      })();
      setMicEnabled(target);
      sessionStorage.setItem('rsn_mic', String(target));
      setHostMuteCommand(null);
      setTimeout(() => setHostMuteProcessing(false), 500);
    }
  }, [hostMuteCommand, isHost, localParticipant, setHostMuteCommand]);

  const toggleMic = useCallback(async () => {
    if (hostMuteProcessing) return;
    const next = !micEnabled;
    await localParticipant.setMicrophoneEnabled(next);
    setMicEnabled(next);
    sessionStorage.setItem('rsn_mic', String(next));
  }, [localParticipant, micEnabled, hostMuteProcessing]);

  const toggleCam = useCallback(async () => {
    const target = !camEnabled;
    setCamEnabled(target); // Optimistic UI update
    try {
      await localParticipant.setCameraEnabled(target);
    } catch (err) {
      console.error('Camera toggle failed:', err);
      // Recovery WITHOUT stopping tracks — the camera publication is the
      // event-scoped engine track (lib/bgEngine); stopping it would kill the
      // camera + background pipeline for the REST OF THE EVENT. A plain retry
      // covers the transient failures the old "stop everything" path targeted.
      if (target) {
        try {
          await new Promise(r => setTimeout(r, 300));
          await localParticipant.setCameraEnabled(true);
        } catch (retryErr) {
          console.error('Camera retry also failed:', retryErr);
        }
      }
    }
    // Always sync from actual state after 500ms + persist preference
    setTimeout(() => {
      const actual = localParticipant.isCameraEnabled;
      setCamEnabled(actual);
      sessionStorage.setItem('rsn_cam', String(actual));
    }, 500);
  }, [localParticipant, camEnabled]);

  const handleMuteAll = useCallback(() => {
    if (!sessionId) return;
    const socket = getSocket();
    const newMuted = !allMuted;
    socket?.emit('host:mute_all', { sessionId, muted: newMuted });
    // allMuted is derived from participant state; it will update via useParticipants
    // once remote mic states change in response to host:mute_all command.
  }, [sessionId, allMuted]);

  return (
    <div className="flex items-center gap-1.5">
      {/* Bug 17 (April 19) — labels show STATE not action. Was: when camera
          on, button text said "Cam Off" (= click to turn off) which confused
          hosts into thinking the camera was already off. Now: text matches
          icon — both reflect current state, button colour signals action
          affordance (red bg = currently off, click to turn on). Tooltip
          gives the action verb for clarity. */}
      <button
        onClick={toggleMic}
        title={micEnabled ? 'Click to mute' : 'Click to unmute'}
        aria-label={micEnabled ? 'Mic on' : 'Mic off'}
        className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
          micEnabled
            ? 'bg-black/40 text-white hover:bg-black/60'
            : 'bg-red-500/80 text-[#1a1a2e] hover:bg-red-600/80'
        }`}
      >
        {micEnabled ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
        {/* Bug 51 (19 May Stefan) — text label hidden on mobile so the
            three controls fit inside compact-mode tiles (~108 px wide
            at 360 px viewport, 3 cols). Title + aria-label keep the
            affordance accessible. */}
        <span className="hidden sm:inline">{micEnabled ? 'Mic On' : 'Mic Off'}</span>
      </button>
      <button
        onClick={toggleCam}
        title={camEnabled ? 'Click to turn camera off' : 'Click to turn camera on'}
        aria-label={camEnabled ? 'Camera on' : 'Camera off'}
        className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
          camEnabled
            ? 'bg-black/40 text-white hover:bg-black/60'
            : 'bg-red-500/80 text-[#1a1a2e] hover:bg-red-600/80'
        }`}
      >
        {camEnabled ? <Video className="h-3 w-3" /> : <VideoOff className="h-3 w-3" />}
        <span className="hidden sm:inline">{camEnabled ? 'Cam On' : 'Cam Off'}</span>
      </button>
      {/* Virtual background toggle */}
      <div className="relative">
        {bg.supported && (
        <button
          onClick={() => {
            if (!showBgPanel) bg.prewarm(); // build the pipeline while the user chooses
            setShowBgPanel(!showBgPanel);
          }}
          aria-label="Background effects"
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
            bg.current.mode !== 'disabled' ? 'bg-indigo-500/80 text-white' : 'bg-black/40 text-white hover:bg-black/60'
          }`}
          title="Background effects"
        >
          <Sparkles className="h-3 w-3" />
          <span className="hidden sm:inline">BG</span>
        </button>
        )}
        {showBgPanel && bg.supported && (
          // Shared picker (BackgroundPanel) — identical UI in lobby, breakout
          // and manual rooms; bottom sheet on mobile, centered card on desktop.
          <BackgroundPanel
            current={bg.current}
            degraded={bg.degraded}
            applying={bg.applying}
            onApply={bg.apply}
            onUpload={bg.applyUpload}
            onClose={() => setShowBgPanel(false)}
          />
        )}
      </div>
      {isHost && sessionId && (
        <button
          onClick={handleMuteAll}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
            allMuted
              ? 'bg-red-500/80 text-[#1a1a2e] hover:bg-red-600/80'
              : 'bg-black/40 text-white hover:bg-black/60'
          }`}
        >
          {allMuted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          {allMuted ? 'Unmute All' : 'Mute All'}
        </button>
      )}
    </div>
  );
}

/**
 * F3 (21 May Ali) — mirrors LiveKit's room participant list into the
 * Zustand store so every UI surface outside <LiveKitRoom> (the participant
 * drawer, the lobby header counter, the host participant panel) can read
 * a realtime "who is actually in the main room right now" list without
 * needing to be inside the LiveKit context itself.
 *
 * Why this exists: socket-fanned participant:joined/left events miss some
 * viewers (confirmed by the 21 May tests — refresh shows the correct
 * count, but the live list drifts because not every browser receives
 * every fan-out emit). LiveKit's room state is the only signal every
 * browser subscribes to the same server-side source for, so it converges
 * across viewers.
 *
 * Mount this once inside the lobby <LiveKitRoom> (after the user joins).
 * Renders nothing; effect-only.
 */
function LiveKitPresenceSync() {
  const livekitParticipants = useParticipants();
  const connectionState = useConnectionState();
  const setLiveRoomParticipants = useSessionStore(s => s.setLiveRoomParticipants);
  const lastKeyRef = useRef<string>('');
  // S21 (live-test z1) — while OUR OWN connection renegotiates, LiveKit's
  // participant set collapses to just the local participant for a few
  // seconds. Publishing that flashed "0 participants + 1 host" and blanked
  // every roster consumer. During reconnect we HOLD the last good roster —
  // truth isn't reachable in that window anyway — capped at 15s, after
  // which we publish whatever LiveKit reports rather than lie forever.
  const holdDeadlineRef = useRef(0);
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) {
      if (holdDeadlineRef.current === 0) holdDeadlineRef.current = Date.now() + 15_000;
      if (Date.now() < holdDeadlineRef.current) return; // hold last roster
    } else {
      holdDeadlineRef.current = 0;
    }
    // Local + remote both come back from useParticipants(); identity is
    // the LiveKit token's identity field, which the server sets to the
    // userId (same invariant the tile-sort relies on at line ~122).
    const list = livekitParticipants
      .map(p => ({ userId: p.identity || '', displayName: p.name || '' }))
      .filter(p => p.userId);
    // Compose a stable key so the store write fires ONLY when room
    // membership actually changes — not on every LiveKit metadata tick.
    const key = list.map(p => p.userId).sort().join('|') + '#' + list.length;
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      setLiveRoomParticipants(list);
    }
  });
  // Reset the store list when this component unmounts (user leaves the
  // LiveKit room). The selector hook then falls back to the durable
  // socket-fed roster.
  useEffect(() => {
    return () => setLiveRoomParticipants([]);
  }, [setLiveRoomParticipants]);
  return null;
}

/**
 * Hook: delays "host is offline" by a grace period to avoid flickering on brief disconnects.
 * Also checks participant list as a fallback.
 * - Starts as `null` (unknown) until session:state arrives
 * - First signal: shows the real value immediately (no grace period)
 * - Subsequent online→offline transitions: 5s grace period to absorb blips
 */
function useHostPresence(gracePeriodMs = 15000): boolean | null {
  const rawHostInLobby = useSessionStore(s => s.hostInLobby);
  // F3 (21 May Ali) — host-presence check must use the realtime in-room
  // list, not the drift-prone socket roster. Otherwise the "host online"
  // banner can be stuck on or off for some viewers when participant:left
  // for the host gets missed.
  const participants = useInRoomParticipants();
  const hostUserId = useSessionStore(s => s.hostUserId);

  const hostInParticipants = hostUserId ? participants.some(p => p.userId === hostUserId) : false;
  const isHostOnline = rawHostInLobby || hostInParticipants;

  const [debouncedOnline, setDebouncedOnline] = useState<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasEverOnline = useRef(false);

  useEffect(() => {
    if (!hostUserId) return;

    if (isHostOnline) {
      wasEverOnline.current = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setDebouncedOnline(true);
    } else {
      if (wasEverOnline.current) {
        // Host was online, now offline — apply grace period for brief disconnects
        timerRef.current = setTimeout(() => {
          setDebouncedOnline(false);
          timerRef.current = null;
        }, gracePeriodMs);
      } else {
        // Host was never online — show offline immediately, no grace period
        setDebouncedOnline(false);
      }
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isHostOnline, hostUserId, gracePeriodMs]);

  return debouncedOnline;
}

function LobbyStatusOverlay({ isHost }: { isHost: boolean }) {
  // F3 (21 May Ali) — counter must reflect REALTIME LiveKit room presence,
  // not the store's socket-fed roster which drifts per viewer when
  // participant:joined/left fan-out misses a client. useInRoomParticipants
  // returns the LiveKit identity set when the room is mounted, falling
  // back to the durable roster pre-LiveKit.
  // P2-1 — field selectors (header rebuilt itself on every store write before).
  // The participant-count selectors that used to live here moved to the top bar
  // (TopBarParticipantCount) along with the count itself — this overlay now only
  // renders transient state messages, not the steady-state heading/count.
  const isByeRound = useSessionStore(s => s.isByeRound);
  const transitionStatus = useSessionStore(s => s.transitionStatus);
  const sessionStatus = useSessionStore(s => s.sessionStatus);
  const leftCurrentRound = useSessionStore(s => s.leftCurrentRound);
  const hostOnline = useHostPresence();

  // Session hasn't been started yet by host
  const isScheduled = sessionStatus === 'scheduled';

  return (
    <div className="text-center space-y-3">
      {sessionStatus === 'closing_lobby' ? (
        // Blocking "All rounds complete" overlay removed (April 17 screenshot).
        // Host has controls to start another round / end; participants can
        // navigate to Recap from the event detail page.
        isHost ? (
          <p className="text-gray-400 text-sm max-w-xs mx-auto">
            Start another round or end the event below.
          </p>
        ) : null
      ) : isByeRound ? (
        <>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Sitting this one out</h2>
          <p className="text-gray-400 text-sm">You'll be matched in the next round</p>
        </>
      ) : transitionStatus === 'session_ending' ? (
        // "Wrapping up..." overlay removed (April 17 screenshot). Host controls
        // already show the end-of-event state; no need for a blocking message.
        null
      ) : transitionStatus === 'between_rounds' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-[#1a1a2e]">Next round starting...</h2>
        </div>
      ) : transitionStatus === 'starting_session' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-[#1a1a2e]">Starting...</h2>
        </div>
      ) : leftCurrentRound && !isHost && sessionStatus === 'round_active' ? (
        <div className="flex flex-col items-center gap-3">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-blue-500/10 text-blue-400">
            <Users className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Back in Main Room</h2>
          <p className="text-gray-400 text-sm max-w-xs">
            The host may assign you to a new room
          </p>
        </div>
      ) : (sessionStatus === 'round_active' || sessionStatus === 'round_rating') ? (
        !isHost ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
            <h2 className="text-xl font-bold text-[#1a1a2e]">Round in progress</h2>
          </div>
        ) : null
      ) : isScheduled ? (
        // Phase 8 (1 May spec) — Stefan: 'too much space at top of main room
        // before the participants show'. Pre-Phase-8 stacked icon + h2 +
        // paragraph + count over ~150px before the video grid. Compact this
        // to a single inline row so the participant grid takes most of the
        // viewport. Same change applied to the Main-Room state below.
        <div className="inline-flex items-center justify-center gap-3">
          <Sparkles className="h-4 w-4 text-gray-400" />
          <h2 className="text-base font-semibold text-[#1a1a2e]">Waiting Room</h2>
          <span className="text-xs text-gray-400 hidden sm:inline">
            {isHost
              ? '· Click Start Event below'
              : hostOnline
                ? '· Host joined — starting soon'
                : '· Waiting for host'}
          </span>
        </div>
      ) : (
        // UX (June-10) — the steady-state main-room heading and the
        // "X participants · Y host" count are gone from here: the top bar already
        // shows the room state, and the participant count now lives there too.
        // Above the tiles we keep ONLY the density toggle, so the video grid
        // reclaims that vertical space. The transient overlays above (bye round,
        // "Next round starting…", "Round in progress", "Back in Main Room") still
        // render — those are momentary states with no tiles to crowd.
        null
      )}
    </div>
  );
}

// Phase D3 (10 May spec) — single helper for participant-count text.
// Stefan #10: pre-fix, all three counters lumped co-hosts into the
// participant tally and showed "X participants + host" — silently making
// "X" include co-hosts. Now: separate counts for participants vs hosts/
// co-hosts. Examples:
//   1 participant            (no host present, no cohosts)
//   3 participants + host    (host present, no cohosts)
//   3 participants + 2 hosts (host + 1 cohost; or 2 cohosts no host present)
export function formatParticipantHeader(
  participants: { userId: string }[],
  hostUserId: string | null,
  cohosts: Set<string>,
  actingAsHostOverrides: Record<string, boolean | null>,
  hostOnline: boolean | null,
): string {
  // Bug E (15 May Ali) — count must reflect EVERYONE acting as host this
  // event, not just formal session_cohosts.
  // Bug 15 (18 May Stefan) — break the count down further: host vs
  // co-hosts vs regular participants, each as its own pill. Pre-fix the
  // collapsed "X participants + Y hosts" string lumped the director and
  // co-hosts into one count and obscured the actual makeup of the room.
  // Stefan: "Participant counts must separate clearly: participants,
  // hosts, co-hosts, unmatched, matched pairs, trios."
  //
  // hostsSet = director ∪ cohosts ∪ opt-ins − opt-outs (with director
  // always re-added so a stale FALSE row can't demote them).
  const hostsSet = (() => {
    const s = new Set<string>();
    if (hostUserId) s.add(hostUserId);
    for (const c of cohosts) s.add(c);
    for (const [uid, v] of Object.entries(actingAsHostOverrides)) {
      if (v === true) s.add(uid);
      if (v === false) s.delete(uid);
    }
    if (hostUserId) s.add(hostUserId);
    return s;
  })();
  const presentUserIds = new Set(participants.map(p => p.userId));
  // Director counted ONLY when actually present, OR when hostOnline says
  // the OG host is connected but missing from the participants list (the
  // snapshot can lag a beat). Director-not-in-room ⇒ omit from the pill.
  const directorPresent =
    (hostUserId && presentUserIds.has(hostUserId)) || (hostUserId && hostOnline)
      ? 1
      : 0;
  // Co-hosts = hostsSet ∖ {director}, intersected with the present roster.
  let coHostCount = 0;
  for (const uid of hostsSet) {
    if (uid === hostUserId) continue;
    if (presentUserIds.has(uid)) coHostCount++;
  }
  // Participants = everyone in the room who isn't acting as a host.
  const participantCount = Math.max(
    0,
    participants.filter(p => !hostsSet.has(p.userId)).length,
  );

  const parts: string[] = [];
  parts.push(`${participantCount} participant${participantCount !== 1 ? 's' : ''}`);
  if (directorPresent === 1) parts.push('1 host');
  if (coHostCount > 0) parts.push(`${coHostCount} co-host${coHostCount !== 1 ? 's' : ''}`);
  return parts.join(' · ');
}

function HostParticipantPanel({ sessionId }: { sessionId?: string }) {
  // F3 (21 May Ali) — same realtime-presence story as LobbyStatusOverlay.
  const hostUserId = useSessionStore(s => s.hostUserId);
  const cohosts = useSessionStore(s => s.cohosts);
  const participants = useInRoomParticipants();
  // Phase P (Ali's 13 May clarification) — host roster must factor in
  // acting_as_host opt-ins (admins/super_admins joining as host) and
  // opt-outs (cohosts/super_admins joining as participant), with the
  // director always counted. Without this the header read "5 participants
  // + 1 host" when Stefan opted in (he'd show as participant).
  const actingAsHostOverrides = useSessionStore(s => s.actingAsHostOverrides);
  const hostsSet = (() => {
    const s = new Set<string>();
    if (hostUserId) s.add(hostUserId);
    for (const c of cohosts) s.add(c);
    for (const [uid, v] of Object.entries(actingAsHostOverrides)) {
      if (v === true) s.add(uid);
      if (v === false) s.delete(uid);
    }
    if (hostUserId) s.add(hostUserId);
    return s;
  })();
  const [expanded, setExpanded] = useState(true);

  const handleKick = useCallback((userId: string, displayName: string) => {
    if (!sessionId) return;
    if (!window.confirm(`Remove ${displayName} from this event?`)) return;
    const socket = getSocket();
    socket?.emit('host:remove_participant', { sessionId, userId, reason: 'Removed by host' });
  }, [sessionId]);

  return (
    <div className="w-full max-w-4xl mx-auto bg-gray-50 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-400" />
          {/* Phase D3 (10 May) — separate counts so "+ Hosts" reads correctly when cohosts present.
              Phase P (Ali's 13 May clarification) — counts now respect
              acting_as_host opt-ins/opt-outs via hostsSet.
              Bug 7 (13 May live test) — hostsSet is the *registered* roster.
              The lobby header is about who is in the room *right now*, so
              intersect with the participants array. Pre-fix it read
              hostsSet.size which counted a configured cohost even when
              they hadn't joined yet (showed "2 Hosts" with only 1 present). */}
          <span>
            Participants ({participants.filter(p => !hostsSet.has(p.userId)).length})
            {(() => {
              const totalHosts = participants.filter(p => hostsSet.has(p.userId)).length;
              return ` · ${totalHosts} ${totalHosts === 1 ? 'Host' : 'Hosts'}`;
            })()}
          </span>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
      </button>
      {expanded && (
        <div className="border-t border-white/10 px-4 py-2 max-h-48 overflow-y-auto">
          {participants.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-3">No participants yet</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {participants.map(p => (
                <div key={p.userId} className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group/participant relative">
                  <div className="h-8 w-8 rounded-full bg-[#5f6368] flex items-center justify-center text-white text-xs font-semibold shrink-0">
                    {(p.displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm text-gray-300 truncate">{p.displayName || 'User'}</span>
                  {p.userId === hostUserId && (
                    <span className="text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">Host</span>
                  )}
                  {sessionId && p.userId !== hostUserId && (
                    <button
                      onClick={() => handleKick(p.userId, p.displayName || 'User')}
                      className="absolute top-2 right-2 opacity-0 group-hover/participant:opacity-100 transition-opacity text-gray-500 hover:text-red-400 p-1 rounded"
                      title={`Remove ${p.displayName || 'User'}`}
                    >
                      <UserX className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Camera/Mic test — Google Meet style self-preview before joining.
 * Uses raw getUserMedia (no LiveKit room needed).
 */
function DeviceTest() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    let mediaStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;

    // In-app browsers (event link opened inside TikTok / Instagram / LinkedIn)
    // and non-secure contexts expose NO `navigator.mediaDevices` at all. Reading
    // `.getUserMedia` off it throws a SYNCHRONOUS TypeError, which the `.catch()`
    // below never sees — that only catches a REJECTED promise (denied
    // permission). The throw escaped this effect into the Lobby error boundary,
    // and since boundaries don't self-heal it stranded those users on "Something
    // went wrong in Lobby" permanently — they could never enter the event, not
    // even after the host started. Degrade to the same camera-less state a
    // denied permission gives: no self-preview, but they still join and
    // see/hear everyone.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera isn't available in this browser. You can still join — open in Safari or Chrome for video.");
      return;
    }

    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(s => {
        if (!mounted) { s.getTracks().forEach(t => t.stop()); return; }
        mediaStream = s;
        setStream(s);
        if (videoRef.current) videoRef.current.srcObject = s;

        // Set up mic level meter
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(s);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!mounted) return;
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setMicLevel(Math.min(avg / 128, 1));
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (mounted) setError('Camera or microphone not available');
      });

    return () => {
      mounted = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioCtx) audioCtx.close().catch(() => {});
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    };
  }, []);

  const toggleCam = () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setCamOn(track.enabled); }
  };

  const toggleMic = () => {
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setMicOn(track.enabled); }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="h-32 w-48 rounded-xl bg-[#3c4043] flex items-center justify-center">
          <VideoOff className="h-8 w-8 text-gray-500" />
        </div>
        <p className="text-xs text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Camera preview — large, prominent, the main thing users see */}
      <div className="relative w-full aspect-video max-w-lg rounded-2xl overflow-hidden bg-gray-900 shadow-lg">
        <video
          ref={videoRef}
          autoPlay muted playsInline
          className="h-full w-full object-cover"
          style={{ transform: 'scaleX(-1)', display: camOn ? 'block' : 'none' }}
        />
        {!camOn && (
          <div className="h-full w-full flex items-center justify-center bg-gray-100">
            <VideoOff className="h-10 w-10 text-gray-400" />
          </div>
        )}

        {/* Controls overlaid on bottom of camera — Google Meet style */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white/90 backdrop-blur-sm rounded-full px-4 py-2 shadow-md">
          <button onClick={toggleCam} className={`p-2 rounded-full transition-colors ${camOn ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-red-500 text-white'}`}>
            {camOn ? <Camera className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          </button>
          <button onClick={toggleMic} className={`p-2 rounded-full transition-colors ${micOn ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-red-500 text-white'}`}>
            {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </button>
          {/* Mic level bar */}
          <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-75 ${micOn ? 'bg-green-500' : 'bg-gray-400'}`} style={{ width: `${micOn ? micLevel * 100 : 0}%` }} />
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-400">Check your camera and mic before the event starts</p>
    </div>
  );
}

/**
 * Participant-only waiting room shown before the host starts the event.
 * Camera-first layout: video preview is the primary content,
 * status overlay is secondary — matches how Google Meet / FaceTime handle pre-call.
 */
function PreLobbyWaitingRoom({ isHost = false, sessionId }: { isHost?: boolean; sessionId?: string }) {
  const participants = useSessionStore(s => s.participants);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const cohosts = useSessionStore(s => s.cohosts);
  // Bug E (15 May Ali) — count acting hosts (Phase M opt-ins) too.
  const actingAsHostOverrides = useSessionStore(s => s.actingAsHostOverrides);
  const hostOnline = useHostPresence();

  // S26 (live-test 2026-06-07) — a participant whose socket silently fell
  // out of the broadcast room never hears session:status_changed when the
  // host presses Start, and sat on this screen until a manual refresh.
  // The server now also fans the start out per-user; this poll is the
  // second, socket-independent layer: every 10s ask the REST snapshot
  // (server truth) and unblock the gate the moment the event is live.
  //
  // S27 — opening the gate with ONLY the status flag left a half-
  // initialized lobby: no lobbyToken → "Main Room" shell with no video
  // (alihammza on mobile, event v1). Converge FULLY instead: apply the
  // whole snapshot atomically AND pull the session:resync rail — the
  // resync reply mints the lobby token for our canonical location and is
  // direct request/response, so it works even on an unseated socket.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    // One convergence pass: ask the REST snapshot (server truth) and, if the
    // event is live, apply it + pull both token rails. Shared by the interval
    // AND the foreground listeners below.
    const converge = async () => {
      if (cancelled) return;
      try {
        const r = await api.get(`/sessions/${sessionId}/state`);
        const d = r.data?.data;
        if (d?.sessionStatus && d.sessionStatus !== 'scheduled') {
          const s = useSessionStore.getState();
          s.applyFullState(d);
          // Token rail #1 — socket resync (request/response: works even on
          // an UNSEATED socket).
          getSocket()?.emit('session:resync' as any, { sessionId, haveSeq: useSessionStore.getState().snapshotSeq });
          // Token rail #2 — ZERO-socket heal (zombie websocket on mobile):
          // REST-mint the lobby token directly. Both rails are idempotent.
          if (!useSessionStore.getState().lobbyToken) {
            try {
              const t = await api.post(`/sessions/${sessionId}/token`, {});
              const td = t.data?.data;
              const cur = useSessionStore.getState();
              if (td?.token && !cur.lobbyToken) cur.setLobbyToken(td.token, td.livekitUrl, td.roomId ?? null);
            } catch { /* resync rail covers */ }
          }
        }
      } catch { /* transient — next tick / next foreground retries */ }
    };

    const iv = setInterval(converge, 10_000);

    // MOBILE STUCK-AT-WAITING-ROOM (2026-06-08, alihammza) — the 10s interval
    // is THROTTLED/PAUSED by mobile browsers while the tab is backgrounded or
    // the screen is locked, and the websocket is a silent zombie, so when the
    // host presses Start during that window NOTHING converges until a full
    // refresh. Converge the instant the tab returns to the foreground (and on
    // network regain) so coming back — without refreshing — pulls the user in.
    // Same return-to-foreground pattern the in-room ReconnectOnReturn uses.
    const onForeground = () => { if (document.visibilityState === 'visible') void converge(); };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    window.addEventListener('online', onForeground);
    // Fire once on mount too (covers a tab that loaded already-backgrounded).
    void converge();

    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      window.removeEventListener('online', onForeground);
    };
  }, [sessionId]);

  return (
    <div className="flex-1 flex flex-col bg-white">
      {/* Camera-first: DeviceTest is the primary content area */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-lg">
          {/* Large camera preview — the main thing you see */}
          <DeviceTest />

          {/* Status strip — compact overlay below camera */}
          <div className="mt-4 flex flex-col items-center gap-2">
            {hostOnline === true ? (
              <div className="inline-flex items-center gap-2 bg-green-50 border border-green-200 px-4 py-2 rounded-full">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-sm font-medium text-green-700">Host is here — event starting soon</span>
              </div>
            ) : hostOnline === false ? (
              <div className="inline-flex items-center gap-2 bg-gray-50 border border-gray-200 px-4 py-2 rounded-full">
                <span className="h-2 w-2 rounded-full bg-gray-400" />
                <span className="text-sm font-medium text-gray-600">Waiting for host to start the event</span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 bg-gray-50 border border-gray-200 px-4 py-2 rounded-full">
                <span className="h-2 w-2 rounded-full bg-gray-500 animate-pulse" />
                <span className="text-sm font-medium text-gray-600">Connecting...</span>
              </div>
            )}

            {/* Participant count — compact inline.
                Phase D3 (10 May spec) — uses formatParticipantHeader so
                co-hosts are counted as hosts, not silently lumped into the
                participant tally. */}
            {participants.length > 0 && (
              <div className="flex items-center gap-2 text-gray-500 text-xs">
                <Users className="h-3.5 w-3.5" />
                <span>
                  {formatParticipantHeader(participants, hostUserId, cohosts, actingAsHostOverrides, hostOnline)} waiting
                </span>
              </div>
            )}

            {/* Host sees participant names */}
            {isHost && participants.length > 0 && (
              <div className="flex flex-wrap gap-2 justify-center mt-2">
                {participants.map(p => (
                  <span key={p.userId} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
                    p.userId === hostUserId ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-gray-100 text-gray-600'
                  }`}>
                    <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      p.userId === hostUserId ? 'bg-amber-100' : 'bg-gray-200'
                    }`}>
                      {(p.displayName || 'U').charAt(0).toUpperCase()}
                    </span>
                    {p.displayName || 'User'}
                    {p.userId === hostUserId && <span className="text-[9px] text-amber-600 ml-0.5">(Host)</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Lobby({ isHost = false, sessionId }: { isHost?: boolean; sessionId?: string }) {
  // P2-1 — the TOP-LEVEL lobby component: a whole-store subscription here
  // rippled re-renders through LobbyMosaic (the entire video grid) on every
  // timer tick. Field selectors make the grid re-render only when these
  // actually change.
  const participants = useSessionStore(s => s.participants);
  const lobbyToken = useSessionStore(s => s.lobbyToken);
  const lobbyUrl = useSessionStore(s => s.lobbyUrl);
  const sessionStatus = useSessionStore(s => s.sessionStatus);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const roundDashboard = useSessionStore(s => s.roundDashboard);

  // Host sees breakout room dashboard only when there are ACTIVE rooms (not stale disconnected/completed)
  const hasActiveRooms = roundDashboard?.rooms.some((r: any) => r.status === 'active');
  const showRoundDashboard = isHost && roundDashboard && hasActiveRooms;

  // LOBBY GATE: Participants cannot enter the lobby before the host starts the event.
  // Show a dedicated waiting room instead. Host still sees the normal lobby with controls.
  if (!isHost && sessionStatus === 'scheduled') {
    return <PreLobbyWaitingRoom isHost={isHost} sessionId={sessionId} />;
  }

  // If we have a lobby token, render the video mosaic
  if (lobbyToken && lobbyUrl) {
    return (
      // Phase 8 (1 May spec) — tighter top-padding + gap so the video grid
      // dominates the viewport. Stefan: 'banners take more than half the
      // screen before the participant grid shows'. p-3 sm:p-6 gives mobile
      // plenty of space for content; gap-3 sm:gap-6 keeps desktop airy.
      <div className="flex-1 flex flex-col items-center p-3 sm:p-6 gap-3 sm:gap-4 overflow-auto bg-white">
        {showRoundDashboard && (
          <div className="w-full max-w-4xl">
            <HostRoundDashboard sessionId={sessionId!} />
          </div>
        )}
        <LobbyStatusOverlay isHost={isHost} />
        <DensityToggle />
        {isHost && <HostParticipantPanel sessionId={sessionId} />}
        <LiveKitRoom
          token={lobbyToken}
          serverUrl={lobbyUrl}
          connect={true}
          // video is published by BgCameraPublisher: the EVENT-SCOPED camera
          // track (lib/bgEngine) with the background pipeline already attached
          // is reused across every room — never re-acquired, never re-segmented.
          // The publisher unpublishes it (without stopping) BEFORE this room
          // disconnects, so the SDK's disconnect cleanup never touches it.
          video={false}
          // WS3/E4 — deliberate lobby publish POLICY: non-hosts JOIN muted
          // (audio={isHost} = initial capture off — a 50-person main room
          // joining hot-mic'd is chaos) but their token allows publishing,
          // so the mic button unmutes them and they ARE heard. The old
          // "can't be heard in main room" was the per-tile remount re-mute
          // (fixed below in LobbyMediaControls — SID-keyed once-only).
          audio={isHost}
          className="flex-1 w-full max-w-4xl"
          options={{
            // C2/VID-1 (audit 2026-06-12) — subscriber-side diet: each remote
            // video uses the simulcast layer matching its rendered tile size,
            // and unattached / off-screen tiles are paused. AUDIO IS NEVER
            // AFFECTED — every mic stays subscribed and rendered below.
            adaptiveStream: true,
            // Publisher-side diet: stop encoding simulcast layers nobody consumes.
            dynacast: true,
            videoCaptureDefaults: { resolution: { ...BG_CAPTURE_RESOLUTION } },
            // Pin the sub-layers (today's library default, explicit so an
            // upgrade can't silently fatten the room) + cap the top layer at
            // 800kbps/24fps at the ENCODER (no change to BG capture resolution).
            publishDefaults: {
              videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
              videoEncoding: { maxBitrate: 800_000, maxFramerate: 24 },
            },
            // WS3/E4 — pin echo/noise processing on for the main-room mic.
            audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          }}
        >
          {/* F3 (21 May Ali) — sync LiveKit room presence into the store
              so the participant drawer / counter / host panel (rendered
              outside this <LiveKitRoom>) get realtime in-room presence
              without depending on socket fan-out for participant
              join/leave events. */}
          <LiveKitPresenceSync />
          <BgCameraPublisher />
          <RoomAudioRenderer />
          <LobbyMosaic isHost={isHost} sessionId={sessionId} />
        </LiveKitRoom>
      </div>
    );
  }

  // Fallback: text-only lobby (no LiveKit credentials or lobby room)
  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-white">
      <div className="max-w-lg w-full text-center bg-gray-50 rounded-2xl p-8">
        <LobbyStatusOverlay isHost={isHost} />
        {isHost && (
          <div className="mt-4">
            <HostParticipantPanel />
          </div>
        )}
        {isHost && (
          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            {participants.map(p => (
              <span key={p.userId} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
                p.userId === hostUserId ? 'bg-amber-500/10 text-amber-400' : 'bg-white/10 text-gray-300'
              }`}>
                <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  p.userId === hostUserId ? 'bg-amber-500/20' : 'bg-white/10'
                }`}>
                  {(p.displayName || 'U').charAt(0).toUpperCase()}
                </span>
                {p.displayName || 'User'}
                {p.userId === hostUserId && <span className="text-[9px] text-amber-400 ml-0.5">(Host)</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Layout Density Toggle ──────────────────────────────────────────────── */

function DensityToggle() {
  const lobbyDensity = useSessionStore(s => s.lobbyDensity);
  const setLobbyDensity = useSessionStore(s => s.setLobbyDensity);

  const options = [
    { value: 'compact' as const, label: 'Compact' },
    { value: 'normal' as const, label: 'Normal' },
    { value: 'spacious' as const, label: 'Spacious' },
  ];

  return (
    <div className="flex items-center gap-1 bg-white/10 rounded-full p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => setLobbyDensity(o.value)}
          className={`px-3 py-1 text-[11px] font-medium rounded-full transition-colors ${
            lobbyDensity === o.value
              ? 'bg-white/20 text-[#1a1a2e]'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
