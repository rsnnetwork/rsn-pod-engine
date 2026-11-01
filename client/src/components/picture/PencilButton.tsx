// client/src/components/picture/PencilButton.tsx
// The pencil on a picture (30 Oct review, T3a: "Add an edit (pencil) button directly on the profile picture"). A
// 44px round white button, always shown (a phone has no hover), named for what it edits so a screen reader says it.
// The caller places it (bottom right of the photo and of the banner, L1).
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  /** "Edit photo" or "Edit banner". */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export default function PencilButton({ label, onClick, disabled, className }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-reason-ink shadow-[0_6px_18px_rgba(0,0,0,.22)] ring-1 ring-black/5 transition hover:bg-reason-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-reason-red disabled:cursor-default disabled:opacity-70',
        className,
      )}
    >
      <Pencil className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );
}
