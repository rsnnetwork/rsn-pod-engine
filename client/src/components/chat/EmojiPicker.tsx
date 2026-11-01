import { useEffect, useRef, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { EMOJI_PICKER_LIST, insertWithin } from './emoji';

// One emoji picker for every message box (30 Oct 2026 review, item 4.6, L9): "allow adding several emojis at once (now
// it's one by one)". It stays open while emojis are picked, and closes on Escape, a tap outside it, the smile button
// again, Done, or sending. Pressing an emoji never takes the focus from where it is (the press is not let move it), so a
// message box being typed in keeps its caret, and its focus handler (which closes the picker for a phone keyboard)
// never runs. Where the emoji goes is the message box's business: onPick.

export default function EmojiPicker({ open, onClose, onPick, toggleRef, className }: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  /** The button that opens it: a press there is the toggle's, not "outside". */
  toggleRef?: RefObject<HTMLElement>;
  /** Where it sits (it is positioned by the message box that holds it). */
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || panel.current?.contains(t) || toggleRef?.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, toggleRef]);

  if (!open) return null;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Emoji picker"
      data-testid="emoji-picker"
      className={cn('z-20 rounded-xl border border-gray-200 bg-white p-2 shadow-lg', className)}
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))]">
        {EMOJI_PICKER_LIST.map((e) => (
          <button
            key={e}
            type="button"
            // Not let move the focus: the message box keeps its caret and stays as it was.
            onPointerDown={(ev) => ev.preventDefault()}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(e)}
            aria-label={`Add ${e}`}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-xl transition-transform hover:bg-gray-100 active:scale-95"
          >
            {e}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-end border-t border-gray-100 pt-1">
        <button
          type="button"
          onPointerDown={(ev) => ev.preventDefault()}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={onClose}
          className="min-h-[44px] rounded-lg px-4 text-sm font-semibold text-gray-700 hover:bg-gray-100"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Puts an emoji where the caret of a message box is and keeps the caret just after it, without focusing the box (on a
 * phone that would bring the keyboard up over the picker). `apply` sets the new words; the caret is placed once they are
 * drawn. A pick that would run over the box's limit changes nothing.
 */
export function pickInto(
  box: HTMLTextAreaElement | HTMLInputElement | null,
  value: string,
  emoji: string,
  apply: (next: string) => void,
): void {
  const max = box && box.maxLength > 0 ? box.maxLength : Number.MAX_SAFE_INTEGER;
  const next = insertWithin(value, box ? box.selectionStart : null, box ? box.selectionEnd : null, emoji, max);
  if (!next) return;
  apply(next.value);
  requestAnimationFrame(() => {
    if (box && box.isConnected) box.setSelectionRange(next.caret, next.caret);
  });
}
