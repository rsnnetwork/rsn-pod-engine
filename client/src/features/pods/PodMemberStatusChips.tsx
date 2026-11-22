// ─── The status chips over a pod's member list (its director and hosts) ──────────────────────────────────────────
// All, and Active, Invited, Declined and Left when someone is in them, each with its count (memberStatusChips).
// 44px tall; the chosen one is ringed and says so to a screen reader (aria-pressed).
import { cn } from '@/lib/utils';
import { memberStatusChips, type PodMemberCounts, type StatusChipKey } from './pod-members-view';

const TONE: Record<StatusChipKey | 'all', string> = {
  all: 'bg-gray-100 text-gray-700 border-gray-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  invited: 'bg-blue-50 text-blue-700 border-blue-200',
  declined: 'bg-red-50 text-red-600 border-red-200',
  left: 'bg-gray-100 text-gray-500 border-gray-200',
};

export default function PodMemberStatusChips({ counts, total, value, onChange }: {
  counts: PodMemberCounts;
  total: number;
  value: StatusChipKey | null;
  onChange: (key: StatusChipKey | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Show members by status">
      {memberStatusChips(counts, total).map((chip) => (
        <button
          key={chip.key ?? 'all'}
          type="button"
          onClick={() => onChange(chip.key)}
          aria-pressed={value === chip.key}
          data-testid={`pod-members-status-${chip.key ?? 'all'}`}
          className={cn(
            'flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
            TONE[chip.key ?? 'all'],
            value === chip.key ? 'border-rsn-red ring-2 ring-rsn-red/30' : 'hover:opacity-80',
          )}
        >
          <span>{chip.label}</span>
          <span className="font-bold">{chip.count}</span>
        </button>
      ))}
    </div>
  );
}
