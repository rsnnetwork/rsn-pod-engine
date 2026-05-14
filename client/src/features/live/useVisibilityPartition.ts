// Phase T (12 May spec item 2 deferred follow-up) — shared hook for
// the host-visibility partition logic. Originally inlined in Lobby.tsx
// (Phase N); extracted so VideoRoom can apply the same big_speaker /
// producer / normal / hidden rules when a host has been force-joined
// into a breakout room.

import { useCallback, useMemo } from 'react';

export type HostVisibilityMode = 'big_speaker' | 'normal' | 'producer' | 'hidden';

// LiveKit track shape — we only need .participant.identity.
type LikeTrackRef = { participant?: { identity?: string } | null } | any;

export interface VisibilityPartition<T = LikeTrackRef> {
  /** Tracks to render as the dedicated stage row (above the main grid). */
  bigSpeakerTracks: T[];
  /** Tracks to render in the audio-only producer strip (no video tile). */
  producerTracks: T[];
  /** Tracks for the main grid. */
  normalTracks: T[];
  /** Resolve mode for a single track (hidden returns 'hidden'; absent => 'normal'). */
  visibilityFor: (track: T) => HostVisibilityMode;
}

/**
 * Partition LiveKit camera tracks by host visibility mode.
 *
 * 'hidden' tracks are filtered out of all three buckets (callers that
 * need a self-protection exception — e.g. never hide the local user's
 * own tile — should bypass via their own filter).
 */
export function useVisibilityPartition<T extends LikeTrackRef>(
  tracks: T[],
  hostVisibilityModes: Record<string, string>,
): VisibilityPartition<T> {
  const visibilityFor = useCallback(
    (trackRef: T): HostVisibilityMode => {
      const id = trackRef?.participant?.identity;
      if (!id) return 'normal';
      const mode = hostVisibilityModes[id];
      if (mode === 'big_speaker' || mode === 'producer' || mode === 'hidden') {
        return mode;
      }
      return 'normal';
    },
    [hostVisibilityModes],
  );

  return useMemo(() => {
    const big: T[] = [];
    const prod: T[] = [];
    const normal: T[] = [];
    for (const t of tracks) {
      const v = visibilityFor(t);
      if (v === 'big_speaker') big.push(t);
      else if (v === 'producer') prod.push(t);
      else if (v === 'normal') normal.push(t);
      // 'hidden' deliberately falls through — dropped from all buckets.
    }
    return {
      bigSpeakerTracks: big,
      producerTracks: prod,
      normalTracks: normal,
      visibilityFor,
    };
  }, [tracks, visibilityFor]);
}
