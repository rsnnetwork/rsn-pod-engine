import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Check } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import { type OnboardingMessage } from '@rsn/shared';
import OnboardingPage from './OnboardingPage';
import HostPresence from './HostPresence';

// Mirrors ONBOARDING_OPENING_LINE in @rsn/shared (the server's source of truth).
// Duplicated here because the shared package is CommonJS and Vite/Rollup can't
// statically resolve a value re-exported through its `export *` barrel — only
// type-only imports from @rsn/shared bundle cleanly. Keep the two in sync.
const OPENING_LINE =
  "We believe you're here for a reason — do you mind sharing that reason with us?";

// The onboarding "door" — a calm host conversation that replaces the 3-step
// form. The host's fixed opening line renders instantly (no latency); every
// subsequent turn hits POST /onboarding/chat. When the host has understood the
// three things it summarises and we surface a Confirm card → POST /onboarding/
// confirm saves the structured intent and flips the gate. If the LLM is
// unavailable (503) we silently fall back to the existing form.

function HostBubble({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-white border border-gray-200 px-4 py-3 text-[15px] leading-relaxed text-[#1a1a2e] shadow-sm"
    >
      {text}
    </motion.div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-rsn-red px-4 py-3 text-[15px] leading-relaxed text-white shadow-sm"
    >
      {text}
    </motion.div>
  );
}

function TypingDots() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="self-start rounded-2xl rounded-bl-md bg-white border border-gray-200 px-4 py-3 shadow-sm"
    >
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-2 w-2 rounded-full bg-rsn-red/60"
            animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
            transition={{ duration: 1, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
          />
        ))}
      </div>
    </motion.div>
  );
}

export default function ChatbotOnboarding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/';
  const { checkSession } = useAuthStore();
  const { addToast } = useToastStore();

  const [messages, setMessages] = useState<OnboardingMessage[]>([
    { role: 'assistant', content: OPENING_LINE },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fallback, setFallback] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const started = messages.length > 1;

  // Keep the transcript pinned to the latest message / typing indicator.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, sending, ready]);

  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  // API history must start with the user's first reply (the API requires a
  // user-first message list); the opening line is client-only context.
  const apiMessages = () => messages.slice(1);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending || confirming) return;

    const next: OnboardingMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setReady(false);
    setSending(true);
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.style.height = 'auto';
    });

    try {
      const res = await api.post('/onboarding/chat', { messages: next.slice(1) });
      const data = res.data.data as { reply: string; ready: boolean };
      setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
      setReady(!!data.ready);
    } catch (err: any) {
      if (err?.response?.status === 503) {
        setFallback(true);
        return;
      }
      addToast(
        err?.response?.data?.error?.message || 'Something went wrong. Please try again.',
        'error'
      );
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    try {
      await api.post('/onboarding/confirm', { messages: apiMessages() });
      await checkSession();
      addToast('Welcome to Reason!', 'success');
      navigate(redirect, { replace: true });
    } catch (err: any) {
      if (err?.response?.status === 503) {
        setFallback(true);
        return;
      }
      addToast(
        err?.response?.data?.error?.message || 'Could not save just yet. Please try again.',
        'error'
      );
    } finally {
      setConfirming(false);
    }
  }

  function handleKeepTalking() {
    setReady(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // LLM unavailable — silently fall back to the original form so signup is
  // never blocked.
  if (fallback) return <OnboardingPage />;

  return (
    <div
      className="flex min-h-screen flex-col bg-gradient-to-b from-white to-gray-50/50"
      style={{ minHeight: '100dvh' }}
    >
      {/* Header — appears once the conversation has started */}
      <AnimatePresence>
        {started && (
          <motion.header
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 border-b border-gray-100 bg-white/80 px-4 pb-3 backdrop-blur"
            style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}
          >
            <HostPresence size={40} state={sending ? 'thinking' : 'idle'} />
            <div className="leading-tight">
              <div className="text-sm font-semibold text-[#1a1a2e]">Reason</div>
              <div className="text-xs text-gray-400">onboarding</div>
            </div>
          </motion.header>
        )}
      </AnimatePresence>

      {/* Transcript */}
      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-5">
        {!started && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="flex flex-1 flex-col items-center justify-center gap-6 px-2 text-center"
          >
            <HostPresence size={132} state={sending ? 'thinking' : 'idle'} />
            <motion.h1
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25, duration: 0.5 }}
              className="max-w-sm font-display text-2xl font-semibold leading-snug text-[#1a1a2e]"
            >
              {OPENING_LINE}
            </motion.h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.5 }}
              className="text-sm text-gray-400"
            >
              Tell us in your own words — a sentence is plenty.
            </motion.p>
          </motion.div>
        )}

        {started &&
          messages.map((m, i) =>
            m.role === 'assistant' ? (
              <HostBubble key={i} text={m.content} />
            ) : (
              <UserBubble key={i} text={m.content} />
            )
          )}

        {sending && <TypingDots />}

        <AnimatePresence>
          {ready && !sending && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="mt-1 self-stretch rounded-2xl border border-rsn-red/20 bg-rsn-red-light/60 p-4"
            >
              <p className="mb-3 text-sm text-[#1a1a2e]">
                Ready when you are — does that capture it?
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  onClick={handleConfirm}
                  isLoading={confirming}
                  className="min-h-[44px] flex-1 justify-center"
                >
                  <Check className="mr-1.5 h-4 w-4" /> Looks right — save
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleKeepTalking}
                  disabled={confirming}
                  className="min-h-[44px] flex-1 justify-center"
                >
                  Keep talking
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Input bar */}
      {!ready && (
        <div
          className="border-t border-gray-100 bg-white px-3 py-3"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-end gap-2"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow();
              }}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Type your answer…"
              aria-label="Your answer"
              autoFocus
              className="max-h-[120px] min-h-[44px] flex-1 resize-none rounded-2xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:border-rsn-red/40 focus:outline-none focus:ring-2 focus:ring-rsn-red/20"
            />
            <Button
              type="submit"
              isLoading={sending}
              disabled={!input.trim()}
              aria-label="Send"
              className="min-h-[44px] min-w-[44px] rounded-2xl !px-3"
            >
              {!sending && <ArrowUp className="h-5 w-5" />}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
