// client/src/components/ui/ConfirmDialog.tsx
// The one way the app asks "are you sure?" (T2, 1 Nov 2026). It replaces window.confirm(): a browser that has stopped
// showing dialogs for the page, or an in-app browser, answers confirm() with false at once, so the press did nothing
// and said nothing (30 Oct: "admin dashboard buttons don't respond"). This is drawn in the page, portalled to <body>
// through Sheet (a bottom sheet on phones, a centred dialog from 768px), with 44px buttons.
//
// While `busy` the dialog stays open and says so: Cancel, the close button, Escape and the backdrop wait, so an
// answer that comes back is shown where the person is looking.
import { Loader2 } from 'lucide-react';
import Sheet from '@/features/reason/ui/Sheet';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  tone: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** What the confirm button says while busy. Defaults to "Working…". */
  busyLabel?: string;
  cancelLabel?: string;
}

const BUTTON = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] px-4 text-[14px] font-bold disabled:opacity-60';

export default function ConfirmDialog({
  open, title, body, confirmLabel, tone, onConfirm, onCancel, busy = false, busyLabel = 'Working…', cancelLabel = 'Cancel',
}: ConfirmDialogProps) {
  const cancel = () => { if (!busy) onCancel(); };
  return (
    <Sheet
      open={open}
      onClose={cancel}
      title={title}
      footer={(
        <>
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            data-testid="confirm-dialog-cancel"
            className={cn(BUTTON, 'border border-reason-line bg-white text-reason-ink')}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            data-testid="confirm-dialog-confirm"
            className={cn(
              BUTTON,
              'text-white',
              tone === 'danger' ? 'bg-reason-red enabled:hover:bg-reason-red-hover' : 'bg-reason-ink enabled:hover:opacity-90',
            )}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      )}
    >
      <p data-testid="confirm-dialog" className="mt-1 text-[14px] leading-relaxed text-[#454b55] [overflow-wrap:anywhere]">{body}</p>
    </Sheet>
  );
}
