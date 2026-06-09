import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';

const icons = { success: CheckCircle, error: AlertCircle, info: Info };
const styles = {
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  error: 'border-red-500/30 bg-red-500/10 text-red-400',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
};

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
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      <AnimatePresence>
        {visible.map(t => {
          const Icon = icons[t.type];
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 80 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 80 }}
              className={cn('flex items-start gap-3 rounded-xl border p-4 backdrop-blur-sm', styles[t.type])}
            >
              <Icon className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <p className="flex-1 text-sm">{t.message}</p>
              <button onClick={() => removeToast(t.id)} className="hover:opacity-70"><X className="h-4 w-4" /></button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
