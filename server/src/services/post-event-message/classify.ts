import type { PostEventMessageBucket } from '@rsn/shared';

export interface ParticipationInput {
  joinedAt: Date | null;
  leftAt: Date | null;
  roundsCompleted: number;
  /**
   * Whether the event ever had a match. A video meeting has none, and so no rounds to count: judging
   * its attendees by rounds put every one of them in "could_not_join". Without a match the only
   * question left is whether the person was there. The rows are the evidence, not config.eventType,
   * which no server code reads.
   */
  eventHadMatches: boolean;
}

const END_GRACE_MS = 120_000; // within 2 min of event end == "stayed to the end"

export function classifyParticipant(
  p: ParticipationInput,
  eventEndedAt: Date | null,
): PostEventMessageBucket {
  if (!p.joinedAt) return 'no_show';
  if (p.eventHadMatches && p.roundsCompleted < 1) return 'could_not_join';
  if (p.leftAt && eventEndedAt) {
    const gap = eventEndedAt.getTime() - p.leftAt.getTime();
    if (gap > END_GRACE_MS) return 'left_early';
  }
  return 'stayed';
}
