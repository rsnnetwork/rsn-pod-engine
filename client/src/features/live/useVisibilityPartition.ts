// Phase T (12 May spec item 2 deferred follow-up) — shared hook for
// the host-visibility partition logic. Originally inlined in Lobby.tsx
// (Phase N); extracted so VideoRoom can apply the same big_speaker /
// producer / normal / hidden rules when a host has been force-joined
// into a breakout room.

import { useCallback, useMemo } from 'react';

export type HostVisibilityMode = 'big_speaker' | 'normal' | 'producer' | 'hidden';

export interface VisibilityPartition {
  /** Tracks to render as the dedicated stage row (above the main grid). */
  bigSpeakerTracks: any[];
  /** Tracks to render in the audio-only producer strip (no video tile). */
  producerTracks: any[];
  /** Tracks for the main grid. */
  normalTracks: any[];
  /** Resolve mode for a single track (hidden returns 'hidden'; absent => 'normal'). */
  visibilityFor: (track: any) => HostVisibilityMode;
}

/**
 * Partition LiveKit camera tracks by host visibility mode.
 *
 * 'hidden' tracks are filtered out of all three buckets (callers that
 * need a self-protection exception — e.g. never hide the local user's
 * own tile — should bypass via their own filter).
 *
 * Type-erased to `any[]` rather than carrying a LiveKit track generic
 * because the LiveKit track-reference types vary across @livekit/
 * components-core versions and we only need
 * `.participant.identity` for the partition. Type checking on the
 * track refs happens at the call site (Lobby/VideoRoom).
 */
export function useVisibilityPartition(
  tracks: any[],
  hostVisibilityModes: Record<string, string>,
): VisibilityPartition {
  const visibilityFor = useCallback(
    (trackRef: any): HostVisibilityMode => {
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
    const big: any[] = [];
    const prod: any[] = [];
    const normal: any[] = [];
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
