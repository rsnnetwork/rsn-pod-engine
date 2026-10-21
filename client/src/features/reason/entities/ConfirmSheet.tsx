// client/src/features/reason/entities/ConfirmSheet.tsx
// A destructive move (leave an entity, archive one) asks first. The failure is said inside the sheet, which stays
// open, so the member can try again or cancel.
import { useEffect, useRef } from 'react';
import Sheet from '../ui/Sheet';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

interface Props {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmSheet({ open, title, text, confirmLabel, busyLabel, busy, error, onConfirm, onClose }: Props) {
  const errorLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={(
        <>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy} className={PRIMARY_BUTTON}>{busy ? busyLabel : confirmLabel}</button>
        </>
      )}
    >
      <p className="mt-1 text-[14px] leading-relaxed text-[#454b55] [overflow-wrap:anywhere]">{text}</p>
      {error && <p ref={errorLine} role="alert" className="mt-3 text-[13px] text-reason-red-hover">{error}</p>}
    </Sheet>
  );
}
