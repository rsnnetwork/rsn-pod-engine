// ─── When each round of a speed-networking event is expected to start (10 Nov 2026 spec, 12) ─────────────
//
// An estimate for the organiser's board and the participant's schedule before the event: round r starts
// (r - 1) × (round length + rating window + 30 s) after the scheduled start. The same arithmetic the server uses
// for how long a LiveKit token for the event lives (livekitTokenTtlSeconds), with the same fallbacks for an old
// config that lacks a length (8 minutes a round, 30 seconds to rate). The live event keeps its own clock.

import type { SessionConfig } from '../types/session';

/** The gap between rounds the live event leaves besides the round and the rating window. */
const BETWEEN_ROUNDS_SECONDS = 30;

/**
 * Each round's estimated start as an ISO string, round 1 first, or nulls when the event has no start time
 * (or an unreadable one).
 */
export function estimatedRoundStarts(
  scheduledAt: string | Date | null,
  config: Pick<SessionConfig, 'numberOfRounds' | 'roundDurationSeconds' | 'ratingWindowSeconds'>,
): Array<string | null> {
  const rounds = Math.max(0, Math.floor(Number(config.numberOfRounds) || 0));
  const start = scheduledAt === null ? NaN : new Date(scheduledAt).getTime();
  if (!Number.isFinite(start)) return new Array<string | null>(rounds).fill(null);
  const step = (config.roundDurationSeconds || 480) + (config.ratingWindowSeconds || 30) + BETWEEN_ROUNDS_SECONDS;
  return Array.from({ length: rounds }, (_, i) => new Date(start + i * step * 1000).toISOString());
}
