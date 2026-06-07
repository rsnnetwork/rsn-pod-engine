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
import { useEffect } from 'react';
import { useConnectionState, useRoomContext } from '@livekit/components-react';
import { ConnectionState, Track } from 'livekit-client';
import { getBgEngine } from '@/lib/bgEngine';

function pubDebug(...args: unknown[]): void {
  try {
    if (localStorage.getItem('rsn_bg_debug')) {
      // eslint-disable-next-line no-console
      console.log('[bg:pub]', ...args);
    }
  } catch { /* ignore */ }
}

export function BgCameraPublisher() {
  const room = useRoomContext();
  const connectionState = useConnectionState(room);

  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;
    let cancelled = false;
    (async () => {
      const engine = getBgEngine();
      const track = await engine.ensureTrack();
      if (!track || cancelled) return;
      const lp = room.localParticipant;
      const existing = lp.getTrackPublication(Track.Source.Camera);
      if (existing?.track === track) return; // already ours (reconnect resume)
      if (existing?.track) {
        // An SDK-created camera track raced us (shouldn't happen with
        // video={false}, but a reconnect edge could) — replace it with the
        // engine track so the background pipeline applies.
        await lp.unpublishTrack(existing.track as any, true).catch(() => {});
      }
      if (cancelled) return;
      // Restore the camera preference BEFORE publish so a camera-off user never
      // flashes video into the room (FIX 15D semantics, now engine-owned).
      const wantCam = sessionStorage.getItem('rsn_cam') !== 'false';
      if (!wantCam && !track.isMuted) await track.mute().catch(() => {});
      if (wantCam && track.isMuted) await track.unmute().catch(() => {});
      // Publishing the camera is THE critical path of the whole video UX — a
      // single swallowed failure here means no video for the entire room stay.
      // Bounded retries cover transient negotiation/connection races.
      for (let attempt = 1; attempt <= 3 && !cancelled; attempt++) {
        try {
          await lp.publishTrack(track, { source: Track.Source.Camera });
          pubDebug('camera published', { attempt, room: room.name });
          return;
        } catch (err) {
          pubDebug('camera publish failed', { attempt, err: String(err) });
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
        }
      }
    })();
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

  return null;
}
