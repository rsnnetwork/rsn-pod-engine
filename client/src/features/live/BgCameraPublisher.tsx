// Publishes the EVENT-SCOPED camera track (lib/bgEngine) into the current
// LiveKit room. Mount once inside every <LiveKitRoom> (lobby AND breakout).
//
// This is the structural half of background persistence: the engine's track —
// with its MediaPipe pipeline already attached — is the same object in every
// room, so a chosen background survives main ↔ breakout ↔ manual transitions
// with ZERO re-segmentation.
//
// Track survival across the room teardown: this component's cleanup runs
// BEFORE the parent <LiveKitRoom>'s disconnect (React unmounts children
// first), and unpublishTrack removes the publication from the participant's
// map synchronously — so the SDK's disconnect cleanup (which stops all still-
// published local tracks, incl. the mic, as it should) never sees the engine
// track. If a publish-in-flight race ever lets it through, the engine
// re-acquires an ended track on the next ensureTrack() instead of staying dead.
//
// Camera on/off keeps using the existing publication-level controls
// (setCameraEnabled → mute/unmute). The engine's track is NOT user-provided in
// livekit terms (created via createLocalVideoTrack), so mute stops capture
// (camera light OFF) and unmute reacquires + auto-restarts the processor —
// the SDK's own privacy semantics, unchanged.
//
// 18 Sep 2026 (Shradha, "camera not working"): the camera is captured (light
// on) the moment the engine acquires it, but the tile reads "camera off" until
// the publish lands, and a publish that failed its three quick tries stayed
// captured-but-unpublished forever with no way out. Now: bounded retries with
// backoff; a final failure MUTES the track so the light goes off and the button
// honestly reads off; and turning the camera on from either room publishes the
// engine track itself (turnCameraOn) instead of letting the SDK open a second
// capture. The rooms show "Starting camera" in between (bgEngine.cameraCaptured).
import { useEffect } from 'react';
import { useConnectionState, useRoomContext } from '@livekit/components-react';
import { ConnectionState, Track, type Room } from 'livekit-client';
import { getBgEngine } from '@/lib/bgEngine';

function pubDebug(...args: unknown[]): void {
  try {
    if (localStorage.getItem('rsn_bg_debug')) {
      // eslint-disable-next-line no-console
      console.log('[bg:pub]', ...args);
    }
  } catch { /* ignore */ }
}

// Waits between publish attempts; the first attempt is immediate.
const PUBLISH_RETRY_MS = [1500, 3000, 5000, 8000];

/**
 * Publish the event camera track into `room`. Resolves true once this room
 * carries the engine track (already ours counts). `forceOn` ignores the saved
 * camera-off preference (the user just asked for the camera).
 * On final failure the track is muted: the camera light must never stay on
 * behind a tile that says off.
 */
export async function publishEngineCamera(
  room: Room,
  isCancelled: () => boolean = () => false,
  opts: { forceOn?: boolean } = {},
): Promise<boolean> {
  const engine = getBgEngine();
  const track = await engine.ensureTrack();
  if (!track || isCancelled()) return false;
  const lp = room.localParticipant;
  const existing = lp.getTrackPublication(Track.Source.Camera);
  if (existing?.track === track) return true; // already ours (reconnect resume)
  if (existing?.track) {
    // An SDK-created camera track raced us (shouldn't happen with
    // video={false}, but a reconnect edge could) — replace it with the
    // engine track so the background pipeline applies.
    await lp.unpublishTrack(existing.track as any, true).catch(() => {});
  }
  if (isCancelled()) return false;
  // Restore the camera preference BEFORE publish so a camera-off user never
  // flashes video into the room (FIX 15D semantics, now engine-owned).
  const wantCam = opts.forceOn || sessionStorage.getItem('rsn_cam') !== 'false';
  if (!wantCam && !track.isMuted) await track.mute().catch(() => {});
  if (wantCam && track.isMuted) await track.unmute().catch(() => {});
  // Publishing the camera is THE critical path of the whole video UX — a
  // single swallowed failure here means no video for the entire room stay.
  for (let attempt = 1; attempt <= PUBLISH_RETRY_MS.length + 1; attempt++) {
    if (isCancelled()) return false;
    try {
      await lp.publishTrack(track, { source: Track.Source.Camera });
      pubDebug('camera published', { attempt, room: room.name });
      return true;
    } catch (err) {
      pubDebug('camera publish failed', { attempt, err: String(err) });
      // The room went away underneath us: the next connection publishes.
      if (room.state !== ConnectionState.Connected) return false;
      const delay = PUBLISH_RETRY_MS[attempt - 1];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (!isCancelled() && !track.isMuted) {
    pubDebug('camera publish gave up: releasing the camera', { room: room.name });
    await track.mute().catch(() => {});
  }
  return false;
}

/**
 * Turn the camera on from a room's controls: unmute the published engine
 * track, or publish it if this room carries no camera publication yet. Never
 * lets the SDK acquire a second camera track. Throws when the publish fails.
 */
export async function turnCameraOn(room: Room): Promise<void> {
  const lp = room.localParticipant;
  const pub = lp.getTrackPublication(Track.Source.Camera);
  if (pub?.track) {
    await lp.setCameraEnabled(true);
    return;
  }
  const ok = await publishEngineCamera(room, () => false, { forceOn: true });
  if (!ok) throw new Error('camera could not be published');
}

export function BgCameraPublisher() {
  const room = useRoomContext();
  const connectionState = useConnectionState(room);

  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;
    let cancelled = false;
    void publishEngineCamera(room, () => cancelled);
    return () => {
      cancelled = true;
      // Detach the engine track from THIS room before it disconnects — without
      // stopping it (stopOnUnpublish=false): the next room republishes the same
      // live, already-processed track. The deletion from the publication map is
      // synchronous, so the room's own disconnect cleanup won't stop it.
      const engine = getBgEngine();
      const track = engine.getTrack();
      if (track) void room.localParticipant.unpublishTrack(track, false).catch(() => {});
    };
  }, [room, connectionState]);

  // #5 (3 Jul, Stefan iOS) — iOS Safari suspends and ENDS the camera track when
  // a native file picker (background upload) or the lock screen takes over. On
  // return the track is dead but still "published", so the normal publish
  // effect above short-circuits (existing.track === engine track) and the user
  // is left staring at a frozen/blank self-view — the "stopped seeing myself"
  // report, including when they open the picker and CANCEL (no apply fires).
  // Heal on visibility/focus return: if the engine track is ended AND the user
  // wants the camera on, reacquire and republish.
  useEffect(() => {
    const healCameraOnReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (connectionState !== ConnectionState.Connected) return;
      void (async () => {
        const engine = getBgEngine();
        const dead = engine.getTrack();
        if (!dead || dead.mediaStreamTrack?.readyState !== 'ended' || dead.isMuted) return;
        const fresh = await engine.ensureTrack(); // self-heals: reacquires camera + reapplies bg
        if (!fresh) return;
        const lp = room.localParticipant;
        const existing = lp.getTrackPublication(Track.Source.Camera);
        if (existing?.track && existing.track !== fresh) {
          await lp.unpublishTrack(existing.track as any, false).catch(() => {});
        }
        if (lp.getTrackPublication(Track.Source.Camera)?.track !== fresh) {
          await lp.publishTrack(fresh, { source: Track.Source.Camera }).catch(() => {});
          pubDebug('camera re-published after iOS suspend/return', { room: room.name });
        }
      })();
    };
    document.addEventListener('visibilitychange', healCameraOnReturn);
    window.addEventListener('focus', healCameraOnReturn);
    window.addEventListener('pageshow', healCameraOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', healCameraOnReturn);
      window.removeEventListener('focus', healCameraOnReturn);
      window.removeEventListener('pageshow', healCameraOnReturn);
    };
  }, [room, connectionState]);

  return null;
}
