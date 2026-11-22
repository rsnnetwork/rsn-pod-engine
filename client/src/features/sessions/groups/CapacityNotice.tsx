// ─── Uneven groups, said before the event (Part 2 Task 11; spec 05, 07) ─────────────────────────────────────────────
// Each affected round's RoundCapacity.sentence (the shared explainRoundCapacity, the matcher's own sum): "In each round
// at most 8 founder and funder meetings are possible, so 17 founders wait. Choose: …". Rounds that say the same are one
// line. Nothing is drawn when everyone has someone to meet.
import { AlertTriangle } from 'lucide-react';
import type { EventGroupRules } from '@rsn/shared';
import { capacityLines } from './group-form';

interface Props {
  rules: EventGroupRules;
  counts: Record<string, number>;
  ungrouped: number;
  numberOfRounds: number;
}

export default function CapacityNotice({ rules, counts, ungrouped, numberOfRounds }: Props) {
  const lines = capacityLines(rules, counts, ungrouped, numberOfRounds);
  if (lines.length === 0) return null;
  return (
    <div data-testid="capacity-notice" role="status" className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {lines.map((line) => (
        <p key={line.rounds} className="flex items-start gap-2 [overflow-wrap:anywhere]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span><span className="font-semibold">{line.rounds}:</span> {line.sentence}</span>
        </p>
      ))}
    </div>
  );
}
