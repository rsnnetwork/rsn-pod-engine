import { create } from 'zustand';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
  /** Hide from the host even when the host normally still sees errors. Use for
   *  non-actionable error notices the host can't do anything about (the host is
   *  running the event, not the person who needs to react). See ToastContainer's
   *  hostQuiet mode. Default false. */
  hostSilent?: boolean;
  /** Internal/admin/system message (e.g. "plan updated", "event plan ready") —
   *  these reflect on-screen UI already and are NOT user-facing event messages,
   *  so they never banner ANYONE (Ali, 9 Jun: participants must not see system
   *  messages). Default false. */
  internal?: boolean;
}

interface ToastOptions {
  hostSilent?: boolean;
  internal?: boolean;
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type: Toast['type'], opts?: ToastOptions) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (message, type, opts) => {
    const id = crypto.randomUUID();
    const duration = type === 'error' ? 6000 : type === 'success' ? 2500 : 4000;
    set((s) => ({ toasts: [...s.toasts, { id, message, type, hostSilent: opts?.hostSilent, internal: opts?.internal }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), duration);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
