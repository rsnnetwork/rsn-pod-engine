// client/src/hooks/useConfirm.tsx
// Ask "are you sure?" from a handler, the way window.confirm() was asked, but in the page (T2, 1 Nov 2026):
//
//   const { ask, confirmDialog } = useConfirm();
//   if (!(await ask({ title: 'Remove Ana?', body: '…', confirmLabel: 'Remove', tone: 'danger' }))) return;
//   …and render {confirmDialog} once in the component.
//
// The answer is true for the confirm button, false for Cancel, the close button, Escape or the backdrop. A question
// asked while another is open answers the first one false.
import { useCallback, useRef, useState, type ReactElement } from 'react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

export interface ConfirmQuestion {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: 'danger' | 'default';
  cancelLabel?: string;
}

export function useConfirm(): { ask: (question: ConfirmQuestion) => Promise<boolean>; confirmDialog: ReactElement } {
  const [question, setQuestion] = useState<ConfirmQuestion | null>(null);
  const pending = useRef<((answer: boolean) => void) | null>(null);

  const settle = useCallback((answer: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setQuestion(null);
    resolve?.(answer);
  }, []);

  const ask = useCallback((next: ConfirmQuestion) => new Promise<boolean>((resolve) => {
    pending.current?.(false);
    pending.current = resolve;
    setQuestion(next);
  }), []);

  const confirmDialog = (
    <ConfirmDialog
      open={!!question}
      title={question?.title ?? ''}
      body={question?.body ?? ''}
      confirmLabel={question?.confirmLabel ?? 'OK'}
      cancelLabel={question?.cancelLabel}
      tone={question?.tone ?? 'default'}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
  return { ask, confirmDialog };
}
