import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';

const icons = { success: CheckCircle, error: AlertCircle, info: Info };
// Dark ink on a solid pale ground reads on whatever is behind the toast (a light page, a dimmed sheet backdrop).
// Pale words on a 10% tint measured 1.75:1 to 2.43:1 on the light pages. The colour meaning is in the border and icon.
const styles = {
  success: { card: 'border-emerald-600 bg-emerald-50', icon: 'text-emerald-700' },
  error: { card: 'border-red-600 bg-red-50', icon: 'text-red-700' },
  info: { card: 'border-blue-600 bg-blue-50', icon: 'text-blue-700' },
};

function ToastCard({ type, message, onDismiss }: { type: 'success' | 'error' | 'info'; message: string; onDismiss: () => void }) {
  const Icon = icons[type];
  return (
    <motion.div
      initial={{ opacity: 0, x: 80 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 80 }}
      className={cn('mb-2 flex items-start gap-3 rounded-xl border py-1 pl-4 pr-1 text-reason-ink shadow-lg', styles[type].card)}
    >
      <Icon aria-hidden="true" className={cn('mt-[11px] h-5 w-5 flex-shrink-0', styles[type].icon)} />
      <p className="min-w-0 flex-1 py-[11px] text-sm [overflow-wrap:anywhere]">{message}</p>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg hover:bg-black/5">
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </motion.div>
  );
}

interface Props {
  /** Live-event host surface: the host is running the event and the UI already
   *  reflects their actions, so confirmation banners (info / success) are pure
   *  noise — they fired on every button press (Ali, 2026-06-09). In this mode we
   *  show ONLY actionable errors (failed to start round, couldn't re-match, etc.
   *  — the things the host genuinely needs to react to), minus any error a caller
   *  flagged hostSilent. Participants and dashboard surfaces pass false and see
   *  everything as before. */
  hostQuiet?: boolean;
}

export default function ToastContainer({ hostQuiet = false }: Props) {
  const { toasts, removeToast } = useToastStore();
  // Internal/admin/system messages ("plan updated", "event plan ready") never
  // banner anyone — they're already reflected in the UI and aren't user-facing
  // event messages (Ali, 9 Jun: participants must not see system messages).
  const userFacing = toasts.filter(t => !t.internal);
  const visible = hostQuiet
    ? userFacing.filter(t => t.type === 'error' && !t.hostSilent)
    : userFacing;
  // z-[210] sits above the REASON sheet overlay (z-[200]), so a toast raised
  // from inside a sheet is not hidden behind its backdrop.
  // The inset is inline so it wins over top-4 / right-4, which stay as the fallback for a browser that knows no
  // env(): the stack clears a notch, and on a phone in landscape its sides. Below 640px it spans the window minus
  // 16px (left and right set, no max width), so a long message wraps inside the margins; from 640px it is a
  // right-aligned stack at most max-w-sm wide.
  // Two live regions, each toast in exactly one: an error is read out at once, the rest when the reader is free.
  // Both are in the page before any toast arrives (a region has to exist to be heard), and aria-atomic="false"
  // makes a reader say only the toast that was added, not the ones already showing.
  return (
    <div
      className="fixed top-4 right-4 z-[210] left-[max(16px,env(safe-area-inset-left))] sm:left-auto sm:max-w-sm"
      style={{ top: 'max(16px, env(safe-area-inset-top))', right: 'max(16px, env(safe-area-inset-right))' }}
    >
      <div role="status" aria-live="polite" aria-atomic="false">
        <AnimatePresence>
          {visible.map(t => t.type !== 'error' && <ToastCard key={t.id} type={t.type} message={t.message} onDismiss={() => removeToast(t.id)} />)}
        </AnimatePresence>
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false">
        <AnimatePresence>
          {visible.map(t => t.type === 'error' && <ToastCard key={t.id} type={t.type} message={t.message} onDismiss={() => removeToast(t.id)} />)}
        </AnimatePresence>
      </div>
    </div>
  );
}
