// ─── The people chosen in the invite sheet (P29: split out of InvitePickerSheet.tsx, 1 Nov 2026) ─────────────────
import { useState } from 'react';
import { X } from 'lucide-react';
import { CHIPS_SHOWN, chipsView } from './invite-picker';
import type { Chosen } from './invite-sheet-style';

/** The people chosen so far, each a chip that removes them; after three the rest fold into "+N". */
export default function InviteChosenChips({ chosen, onRemove }: { chosen: Chosen[]; onRemove: (userId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (chosen.length === 0) return null;
  const { chips, more } = chipsView(chosen, expanded);
  return (
    <div className="mt-3 flex flex-wrap gap-2" aria-label="Chosen">
      {chips.map((c) => (
        <button
          key={c.userId}
          type="button"
          onClick={() => onRemove(c.userId)}
          aria-label={`Remove ${c.displayName}`}
          className="inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-full bg-reason-pink pl-3 pr-2.5 text-[13px] font-bold text-reason-ink"
        >
          <span className="max-w-[10rem] truncate">{c.displayName}</span>
          <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </button>
      ))}
      {more > 0 && (
        <button type="button" onClick={() => setExpanded(true)} aria-label={`Show all ${chosen.length} chosen`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-reason-line px-3 text-[13px] font-bold">
          +{more}
        </button>
      )}
      {expanded && chosen.length > CHIPS_SHOWN && (
        <button type="button" onClick={() => setExpanded(false)} className="inline-flex min-h-[44px] items-center rounded-full px-3 text-[13px] font-bold text-reason-muted underline">
          Show fewer
        </button>
      )}
    </div>
  );
}
