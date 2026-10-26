// ─── The video-meeting stage (26 Oct 2026, VID-01/02) ──────────────────────────
//
// The tiles of a video meeting, laid out by liveLayout.planStage from the stage's
// own measured size: one person large, two people side by side or the other person
// large with yourself small in the corner, an even grid for three or more, a pinned
// or spotlighted person large. Every tile is always fully on the stage, which never
// scrolls, and nobody is made larger for being the host.
//
// MeetingStage reads LiveKit (mount it inside the meeting's <LiveKitRoom>);
// MeetingStageView only draws the tiles it is given.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useConnectionState, useLocalParticipant, useRoomContext, useTracks, VideoTrack } from '@livekit/components-react';
import { isTrackReference, type TrackReferenceOrPlaceholder } from '@livekit/components-core';
import { ConnectionState, RoomEvent, Track } from 'livekit-client';
import { Columns2, Loader2, Mic, MicOff, Pin, PinOff, PictureInPicture2, UserPlus, Users, VideoOff } from 'lucide-react';
import { useSessionStore } from '@/stores/sessionStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { VideoTile } from '../VideoRoom';
import { planStage, SIDE_BY_SIDE_QUERY, type Box, type PairView, type TileFill } from './liveLayout';

export interface StageTile {
  /** The LiveKit participant sid: stable while the layout changes, so a video is never re-attached. */
  key: string;
  userId?: string;
  name: string;
  isLocal: boolean;
  micOn: boolean;
  trackRef?: TrackReferenceOrPlaceholder;
  /** Held on screen while our own connection recovers: a name, no live picture. */
  held?: boolean;
}

/** Space kept along the bottom of the stage for the audio-only producers, when there are any. */
const PRODUCER_STRIP_H = 40;
/** How long the stage holds the last people it saw while our own connection recovers (S21). */
const HOLD_MS = 15_000;
/** On a tile smaller than this a camera-off person's name goes under their initial, not in a corner label. */
const SMALL_TILE = { w: 160, h: 110 };
/**
 * On a tile shorter than this there is no room for a name at all: the small picture of yourself beside the other
 * person on a short stage (fix round 2). It shows the picture alone, or the initial; its label names it to a
 * screen reader ("Show yourself large").
 */
const TINY_TILE_H = 64;

/** A display name for a person on the stage; an email-like name shows only its local part. */
function personName(name: string | undefined, identity: string | undefined): string {
  const raw = (name || '').trim();
  if (raw) return raw.includes('@') ? raw.split('@')[0] : raw;
  return identity ? 'Guest' : 'Participant';
}

/** A camera that is published and not muted (turning a camera off mutes it; UX2). */
function hasLivePicture(trackRef?: TrackReferenceOrPlaceholder): boolean {
  return !!trackRef?.publication?.track && !trackRef.publication.isMuted;
}

/** The size of an element's box, kept up to date as it resizes. */
function useBoxSize<T extends HTMLElement>(): [RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const next = { w: Math.floor(r.width), h: Math.floor(r.height) };
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function initialOf(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

/**
 * A person with no live picture (camera off, or held while we reconnect): their initial, sized to the tile, and
 * their name, under the initial on a small tile and in the corner label on a larger one (where a live tile has it).
 */
function NoPicture({ name, box }: { name: string; box: Box }) {
  const tiny = box.h < TINY_TILE_H;
  const small = box.w < SMALL_TILE.w || box.h < SMALL_TILE.h;
  const size = tiny
    ? Math.max(24, Math.min(32, box.h - 12))
    : Math.round(Math.max(32, Math.min(96, Math.min(box.w, box.h) * 0.36)));
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[#3c4043] px-1">
      <div
        className="flex shrink-0 items-center justify-center rounded-full bg-[#5f6368] font-semibold text-white"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
        aria-hidden="true"
      >
        {initialOf(name)}
      </div>
      {tiny ? null : small ? (
        <span className="max-w-full truncate text-[11px] text-gray-200">{name}</span>
      ) : (
        <span className="absolute bottom-2 left-2 inline-flex max-w-[70%] items-center gap-1 rounded bg-black/60 px-2 py-1 text-xs text-white">
          <VideoOff className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{name}</span>
          <span className="sr-only">, camera off</span>
        </span>
      )}
    </div>
  );
}

/**
 * How a tile answers a tap:
 *   'tap'  the small picture in the corner, or a thumbnail in a pinned view: the whole tile makes that person large;
 *   'pin'  a grid, side-by-side or pinned tile: a pin button in its corner;
 *   'none' the solo tile and the large tile of a two-person view.
 */
type TileAction = { kind: 'tap'; run: () => void } | { kind: 'pin'; run: () => void; pinned: boolean; corner: 'left' | 'right' } | { kind: 'none' };

function StageTileView({ tile, box, fill, inset, action }: { tile: StageTile; box: Box; fill: TileFill; inset: boolean; action: TileAction }) {
  // The breakout's own tile for a live picture (mirroring, name plate, object-fit); a camera that is off gets a
  // picture sized to the tile, so the name never runs into the placeholder on a small tile. A tile too short for
  // the breakout tile's name plate shows the picture alone (the plate would cover most of it).
  const live = !tile.held && hasLivePicture(tile.trackRef);
  const picture = !live
    ? <NoPicture name={tile.name} box={box} />
    : box.h < TINY_TILE_H && isTrackReference(tile.trackRef)
      ? <VideoTrack trackRef={tile.trackRef} className={`h-full w-full ${fill === 'contain' ? 'object-contain' : 'object-cover'}`} />
      : <VideoTile trackRef={tile.trackRef} label={tile.name} userId={tile.userId} fillMode={fill} />;
  const tap = action.kind === 'tap' ? action.run : null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (tap && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tap(); }
  };
  return (
    <div
      data-testid="meeting-tile"
      data-self={tile.isLocal ? 'true' : undefined}
      data-user-id={tile.userId}
      data-inset={inset ? 'true' : undefined}
      className={`absolute overflow-hidden rounded-xl bg-black transition-[left,top,width,height] duration-200 ${
        inset ? 'z-10 shadow-lg ring-2 ring-white/80' : ''
      } ${tap ? 'cursor-pointer' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      role={tap ? 'button' : undefined}
      tabIndex={tap ? 0 : undefined}
      aria-label={tap ? (tile.isLocal ? 'Show yourself large' : `Show ${tile.name} large`) : undefined}
      onClick={tap ?? undefined}
      onKeyDown={tap ? onKey : undefined}
    >
      {picture}
      {!tile.isLocal && !tile.micOn && !tile.held && (
        <span className="absolute bottom-2 right-2 z-10 rounded-full bg-red-600/90 p-1 text-white" title={`${tile.name}'s microphone is off`}>
          <MicOff className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">{`${tile.name}'s microphone is off`}</span>
        </span>
      )}
      {action.kind === 'pin' && (
        // The button is the whole 44px corner; the small circle inside is what shows.
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); action.run(); }}
          aria-label={action.pinned ? `Unpin ${tile.name}` : `Pin ${tile.name}`}
          title={action.pinned ? 'Unpin' : 'Pin'}
          className={`group/pin absolute top-0 ${action.corner === 'left' ? 'left-0' : 'right-0'} z-10 flex h-11 w-11 items-center justify-center`}
        >
          <span
            className={`rounded-full bg-black/55 p-1.5 text-white group-hover/pin:bg-black/75 ${
              action.pinned ? 'ring-1 ring-amber-300/80 text-amber-200' : ''
            }`}
          >
            {action.pinned ? <PinOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Pin className="h-3.5 w-3.5" aria-hidden="true" />}
          </span>
        </button>
      )}
    </div>
  );
}

export interface MeetingStageViewProps {
  /** Index 0 is the viewer's own tile, then the other people in order. */
  tiles: StageTile[];
  /** People heard but not shown on camera (producers). */
  producers: Array<{ key: string; name: string }>;
  /** The pinned or spotlighted tile, or null. */
  focusKey: string | null;
  /** Pinned by this viewer (a host's spotlight cannot be undone here). */
  pinnedKey: string | null;
  onPin: (key: string | null) => void;
  pairView: PairView | null;
  onPairView: (view: PairView) => void;
  /** Still connecting to the room. */
  connecting: boolean;
  /** Our own connection is recovering: the last people seen are held on screen. */
  holding: boolean;
  /** Offered on the solo stage to people who run the meeting. */
  onInvite?: () => void;
  /** Notices for the top of the stage (sound blocked by the browser). */
  notices?: ReactNode;
  /** The room's connection state (LiveKit's ConnectionState), shown on the stage as data-room for tests. */
  roomState?: string;
}

export function MeetingStageView({
  tiles, producers, focusKey, pinnedKey, onPin, pairView, onPairView, connecting, holding, onInvite, notices, roomState,
}: MeetingStageViewProps) {
  const [areaRef, size] = useBoxSize<HTMLDivElement>();
  // Two people sit side by side by default in a window at least 1024px wide and landscape (the window decides,
  // not the stage: a landscape tablet's stage is a few pixels narrower).
  const wide = useMediaQuery(SIDE_BY_SIDE_QUERY);
  const stripH = producers.length > 0 ? PRODUCER_STRIP_H : 0;
  const focusIndex = focusKey ? tiles.findIndex((t) => t.key === focusKey) : -1;
  const plan = useMemo(
    () => planStage({
      width: size.w, height: Math.max(0, size.h - stripH), count: tiles.length,
      focusIndex: focusIndex >= 0 ? focusIndex : null, pairView, wide,
    }),
    [size.w, size.h, stripH, tiles.length, focusIndex, pairView, wide],
  );
  const two = plan.layout === 'pair' || plan.layout === 'side';
  const solo = plan.layout === 'solo' ? plan.boxes[0] : null;

  const actionFor = (tile: StageTile, i: number): TileAction => {
    const focusMain = plan.layout === 'focus' && i === focusIndex;
    if (plan.insetIndex === i || (plan.layout === 'focus' && !focusMain)) return { kind: 'tap', run: () => onPin(tile.key) };
    if (focusMain) {
      // Only this viewer's own pin can be undone here; a host's spotlight stays until the host lifts it.
      if (pinnedKey !== tile.key) return { kind: 'none' };
      return { kind: 'pin', run: () => onPin(null), pinned: true, corner: plan.insetIndex === null ? 'right' : 'left' };
    }
    if (plan.layout === 'grid' || plan.layout === 'side') return { kind: 'pin', run: () => onPin(tile.key), pinned: false, corner: 'right' };
    return { kind: 'none' };
  };

  return (
    <div data-testid="meeting-stage" data-layout={plan.layout} data-room={roomState} className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-[#202124] p-2">
      <div ref={areaRef} className="relative h-full w-full">
        {tiles.map((tile, i) => {
          const box = plan.boxes[i];
          if (!box) return null;
          return <StageTileView key={tile.key} tile={tile} box={box} fill={plan.fills[i]} inset={plan.insetIndex === i} action={actionFor(tile, i)} />;
        })}

        {plan.more && (
          <div
            data-testid="meeting-more"
            className="absolute rounded-xl bg-[#3c4043] flex flex-col items-center justify-center text-gray-200"
            style={{ left: plan.more.box.x, top: plan.more.box.y, width: plan.more.box.w, height: plan.more.box.h }}
          >
            <Users className="h-5 w-5 mb-1" aria-hidden="true" />
            <span className="text-sm font-semibold">+{plan.more.count} more</span>
            <span className="text-[10px] text-gray-400">audio still on</span>
          </div>
        )}

        {solo && (
          // Above the tile's own name label, centred on the tile.
          <div
            className="absolute z-10 flex flex-col items-center justify-end gap-2 px-3 pointer-events-none"
            style={{ left: solo.x, width: solo.w, top: Math.max(solo.y, solo.y + solo.h - 164), height: Math.min(120, solo.h) }}
          >
            <p className="rounded-full bg-black/65 px-4 py-2 text-sm font-medium text-white text-center">
              {connecting ? 'Joining the meeting…' : 'Waiting for others to join'}
            </p>
            {onInvite && !connecting && (
              <button
                type="button"
                onClick={onInvite}
                className="pointer-events-auto inline-flex min-h-[44px] items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-[#1a1a2e] shadow hover:bg-gray-100"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" /> Invite people
              </button>
            )}
          </div>
        )}

        {two && (
          <button
            type="button"
            data-testid="meeting-view-toggle"
            onClick={() => onPairView(plan.layout === 'side' ? 'pair' : 'side')}
            className="absolute left-2 top-2 z-20 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-black/60 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/75"
          >
            {plan.layout === 'side'
              ? <><PictureInPicture2 className="h-4 w-4" aria-hidden="true" /> Focus</>
              : <><Columns2 className="h-4 w-4" aria-hidden="true" /> Side by side</>}
          </button>
        )}

        {producers.length > 0 && (
          <div data-testid="meeting-producers" className="absolute inset-x-0 bottom-0 flex h-8 items-center gap-2 overflow-hidden px-1">
            {producers.map((p) => (
              <span key={p.key} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[11px] text-white" title="Heard, not on camera">
                <Mic className="h-3 w-3 text-gray-300" aria-hidden="true" /> {p.name}
              </span>
            ))}
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex flex-col items-center gap-2 px-14">
          {holding && (
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white shadow">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Reconnecting…
            </span>
          )}
          {notices}
        </div>
      </div>
    </div>
  );
}

/** Re-render on a remote mute or subscribe: useTracks does not, and a tile would show a stale mic or camera (UX2). */
function useTrackStateTick(): void {
  const room = useRoomContext();
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
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
}

type HeldPerson = Pick<StageTile, 'key' | 'userId' | 'name' | 'isLocal'>;

export default function MeetingStage({ onInvite, notices }: { onInvite?: () => void; notices?: ReactNode }) {
  useTrackStateTick();
  const cameraTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const { localParticipant } = useLocalParticipant();
  const connectionState = useConnectionState();
  const hostVisibilityModes = useSessionStore((s) => s.hostVisibilityModes);
  const spotlightUserId = useSessionStore((s) => s.serverPinnedUserId);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [pairView, setPairView] = useState<PairView | null>(null);

  // Who is on the stage: yourself first (never hidden), then everyone else on camera. A host hidden
  // from view is left out; a producer is heard, not shown (Phase N visibility modes). Built on every
  // render: a remote mute changes no array here, only the participant objects (the tick above).
  const own = cameraTracks.find((t) => t.participant.sid === localParticipant.sid);
  const me: StageTile = {
    key: localParticipant.sid || 'local',
    userId: localParticipant.identity || undefined,
    name: 'You',
    isLocal: true,
    micOn: localParticipant.isMicrophoneEnabled,
    trackRef: own,
  };
  const others: StageTile[] = [];
  const producers: Array<{ key: string; name: string }> = [];
  let bigSpeakerKey: string | null = hostVisibilityModes[localParticipant.identity] === 'big_speaker' ? me.key : null;
  for (const t of cameraTracks) {
    if (t.participant.sid === localParticipant.sid) continue;
    const mode = hostVisibilityModes[t.participant.identity];
    const name = personName(t.participant.name, t.participant.identity);
    if (mode === 'hidden') continue;
    if (mode === 'producer') { producers.push({ key: t.participant.sid, name }); continue; }
    if (mode === 'big_speaker' && bigSpeakerKey === null) bigSpeakerKey = t.participant.sid;
    others.push({
      key: t.participant.sid,
      userId: t.participant.identity || undefined,
      name,
      isLocal: false,
      micOn: t.participant.isMicrophoneEnabled,
      trackRef: t,
    });
  }
  const live: StageTile[] = [me, ...others];

  // S21 — while OUR OWN connection renegotiates, every other person vanishes for a few seconds. Hold the
  // last people seen (as names, never as live pictures) with a Reconnecting badge, capped at 15 seconds,
  // so a pair does not flash to the solo stage.
  const connected = connectionState === ConnectionState.Connected;
  const heldRef = useRef<HeldPerson[]>([]);
  const holdUntilRef = useRef(0);
  const [, setHoldTick] = useState(0);
  if (connected) {
    holdUntilRef.current = 0;
    // Every connected render, so someone who has already left is never held as a ghost.
    heldRef.current = live.map(({ key, userId, name, isLocal }) => ({ key, userId, name, isLocal }));
  } else if (holdUntilRef.current === 0 && heldRef.current.length > 1) {
    holdUntilRef.current = Date.now() + HOLD_MS;
  }
  const holding = !connected && holdUntilRef.current > 0 && Date.now() < holdUntilRef.current;
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setHoldTick((x) => x + 1), Math.max(0, holdUntilRef.current - Date.now()) + 100);
    return () => clearTimeout(t);
  }, [holding]);
  const tiles: StageTile[] = holding ? heldRef.current.map((p) => ({ ...p, micOn: true, held: true })) : live;

  // A pin on someone who has left (or was hidden) lapses.
  const liveKeys = live.map((t) => t.key).join('|');
  useEffect(() => {
    if (pinnedKey && !liveKeys.split('|').includes(pinnedKey)) setPinnedKey(null);
  }, [liveKeys, pinnedKey]);

  // A host's spotlight wins, then this viewer's own pin, then a host shown as the big speaker.
  const onStage = (key: string | null) => (key && tiles.some((t) => t.key === key) ? key : null);
  const spotlightKey = spotlightUserId ? tiles.find((t) => t.userId === spotlightUserId)?.key ?? null : null;
  const focusKey = spotlightKey ?? onStage(pinnedKey) ?? onStage(bigSpeakerKey);

  return (
    <MeetingStageView
      tiles={tiles}
      producers={holding ? [] : producers}
      focusKey={focusKey}
      pinnedKey={pinnedKey}
      onPin={setPinnedKey}
      pairView={pairView}
      onPairView={setPairView}
      connecting={!connected && !holding}
      holding={holding}
      onInvite={onInvite}
      notices={notices}
      roomState={connectionState}
    />
  );
}
