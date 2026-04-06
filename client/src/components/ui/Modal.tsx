import { type ReactNode, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export default function Modal({ open, onClose, title, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
            className={cn('relative w-full max-w-lg max-h-[90vh] rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl flex flex-col', className)}
          >
            {title && (
              <div className="flex items-center justify-between p-6 pb-0 mb-4 shrink-0">
                <h2 className="text-lg font-semibold text-[#1a1a2e]">{title}</h2>
                <button onClick={onClose} className="text-gray-500 hover:text-gray-800 transition-colors"><X className="h-5 w-5" /></button>
              </div>
            )}
            <div className="overflow-y-auto p-6 pt-0">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
