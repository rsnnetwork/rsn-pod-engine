// One choice on a question. Full width, comfortably tappable, and a checkbox to
// a screen reader: every question of the brief takes several answers. Disabled
// only when the member is already at the limit and this is not one they
// picked, so the limit is visible rather than a silent refusal to respond.

import { Check } from 'lucide-react';

interface Props {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export default function OptionTile({ label, selected, disabled, onToggle }: Props) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={onToggle}
      className={`flex min-h-[52px] w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        selected
          ? 'border-rsn-red bg-rsn-red-light text-[#1a1a2e]'
          : disabled
            ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
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
      <span className="text-[15px] font-medium leading-snug">{label}</span>
    </button>
  );
}
