// ─── "People must be members of <main pod> to join its pods" (Stefan, 22 Nov 2026) ─────────────────────────────────
// The main pod's director's one setting on the pods inside it, off by default. A switch with the whole row as its 44px
// tap target; while it saves it shows the choice being made and cannot be pressed again. Nobody already in a pod inside
// is taken out when it is turned on (the server never does).
import { useId } from 'react';
import { useSetInnerPodsMembersOnly } from './useNestedPods';
import { membersOnlyHint, membersOnlyLabel } from './nested-pods-view';

interface Props { main: { id: string; name: string }; on: boolean }

export default function InnerPodsMembersOnlySwitch({ main, on }: Props) {
  const hintId = useId();
  const save = useSetInnerPodsMembersOnly(main);
  // While it saves, the switch shows the choice being made.
  const shown = save.isPending && typeof save.variables === 'boolean' ? save.variables : on;
  const label = membersOnlyLabel(main.name);
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium text-[#1a1a2e]">{label}</p>
        <p id={hintId} className="mt-0.5 break-words text-xs text-gray-500">{membersOnlyHint(shown)}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label={label}
        aria-describedby={hintId}
        disabled={save.isPending}
        onClick={() => save.mutate(!on)}
        data-testid="pod-inner-members-only"
        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center disabled:opacity-60"
      >
        <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${shown ? 'bg-rsn-red' : 'bg-gray-300'}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${shown ? 'translate-x-6' : 'translate-x-1'}`} />
        </span>
      </button>
    </div>
  );
}
