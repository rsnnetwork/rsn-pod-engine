// One choice on a question. Full width, comfortably tappable, and a checkbox to
// a screen reader: every question takes all the answers that apply, so a tile is
// never greyed out. A tile may carry a small note ("From LinkedIn"): the tile is
// still named by its answer alone, and the note describes it.

import { useId } from 'react';
import { Check } from 'lucide-react';

interface Props {
  label: string;
  selected: boolean;
  /** What to say about this answer, under it (for example where it was picked from). */
  note?: string;
  onToggle: () => void;
}

export default function OptionTile({ label, selected, note, onToggle }: Props) {
  const id = useId();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-labelledby={`${id}-label`}
      aria-describedby={note ? `${id}-note` : undefined}
      onClick={onToggle}
      className={`flex min-h-[52px] w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        selected
          ? 'border-rsn-red bg-rsn-red-light text-[#1a1a2e]'
          : 'border-gray-200 bg-white text-[#1a1a2e] hover:border-gray-300 hover:bg-gray-50'
      } focus:outline-none focus-visible:ring-2 focus-visible:ring-rsn-red focus-visible:ring-offset-2`}
    >
      <span
        aria-hidden
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
          selected ? 'border-rsn-red bg-rsn-red text-white' : 'border-gray-300 bg-white'
        }`}
      >
        {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-label`} className="block text-[15px] font-medium leading-snug">{label}</span>
        {note && <span id={`${id}-note`} className="mt-0.5 block text-xs font-medium text-gray-600">{note}</span>}
      </span>
    </button>
  );
}
