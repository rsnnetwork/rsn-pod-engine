import type { PostEventMessageBucket } from '@rsn/shared';

export interface ParticipationInput {
  joinedAt: Date | null;
  leftAt: Date | null;
  roundsCompleted: number;
}

const END_GRACE_MS = 120_000; // within 2 min of event end == "stayed to the end"

export function classifyParticipant(
  p: ParticipationInput,
  eventEndedAt: Date | null,
): PostEventMessageBucket {
  if (!p.joinedAt) return 'no_show';
  if (p.roundsCompleted < 1) return 'could_not_join';
  if (p.leftAt && eventEndedAt) {
    const gap = eventEndedAt.getTime() - p.leftAt.getTime();
    if (gap > END_GRACE_MS) return 'left_early';
  }
  return 'stayed';
}
