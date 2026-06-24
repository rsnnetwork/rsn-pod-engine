import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Check, Pencil } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import {
  type OnboardingMessage,
  type OnboardingKnownProfile,
  type OnboardingConfirmedProfile,
} from '@rsn/shared';
import OnboardingPage from './OnboardingPage';
import HostPresence from './HostPresence';

// v1.1 staged onboarding: welcome by name + confirm what we already know, then a
// short chat (the host knows the confirmed profile so it never re-asks), then a
// summary and save. The first chat question mirrors FIRST_QUESTION on the server.
// No dashes anywhere (style rule). If the LLM is down we fall back to the form.
const FIRST_QUESTION =
  "Reason works best when we understand why you're here. What is your reason for joining? One sentence is enough.";

type Stage = 'loading' | 'confirm' | 'chat';

function HostBubble({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md border border-gray-200 bg-white px-4 py-3 text-[15px] leading-relaxed text-[#1a1a2e] shadow-sm"
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
      className="self-start rounded-2xl rounded-bl-md border border-gray-200 bg-white px-4 py-3 shadow-sm"
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

function ConfirmRow({
  label,
  value,
  editing,
  onChange,
  placeholder,
  guessed,
  last,
}: {
  label: string;
  value: string;
  editing: boolean;
  onChange: (v: string) => void;
  placeholder: string;
  guessed?: boolean;
  last?: boolean;
}) {
  return (
    <div className={last ? 'py-2.5' : 'border-b border-gray-100 py-2.5'}>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">
        {label}
        {!editing && guessed && value ? <span className="ml-1.5 normal-case text-gray-400">(a guess, fix if wrong)</span> : null}
      </div>
      {editing ? (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-[15px] text-[#1a1a2e] placeholder:text-gray-400 focus:border-rsn-red/50 focus:outline-none focus:ring-2 focus:ring-rsn-red/20"
        />
      ) : (
        <div className="mt-0.5 text-[15px] text-[#1a1a2e]">
          {value || <span className="text-gray-300">Not set</span>}
        </div>
      )}
    </div>
  );
}

export default function ChatbotOnboarding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/';
  const { user, checkSession } = useAuthStore();
  const { addToast } = useToastStore();

  const [stage, setStage] = useState<Stage>('loading');
  const [known, setKnown] = useState<OnboardingKnownProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', country: '', company: '' });

  const [messages, setMessages] = useState<OnboardingMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fallback, setFallback] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const u = user as any;
  const firstName =
    known?.firstName ||
    (known?.name ? known.name.split(/\s+/)[0] : '') ||
    u?.firstName ||
    (u?.displayName ? u.displayName.split(/\s+/)[0] : '') ||
    'there';

  // Fetch what we already know, then show the confirm card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/onboarding/known');
        if (cancelled) return;
        const k = res.data.data as OnboardingKnownProfile;
        setKnown(k);
        setDraft({ name: k.name || '', country: k.country || '', company: k.company || '' });
        setStage('confirm');
      } catch {
        // Could not load known data, just start the chat without it.
        if (cancelled) return;
        setMessages([{ role: 'assistant', content: FIRST_QUESTION }]);
        setStage('chat');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the chat transcript pinned to the latest message.
  useEffect(() => {
    if (stage !== 'chat') return;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
  }, [messages, sending, ready, stage]);

  function confirmedProfile(): OnboardingConfirmedProfile {
    return {
      name: draft.name.trim() || null,
      country: draft.country.trim() || null,
      company: draft.company.trim() || null,
    };
  }

  function startChat() {
    setEditing(false);
    setMessages([{ role: 'assistant', content: FIRST_QUESTION }]);
    setStage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

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
      const res = await api.post('/onboarding/chat', {
        messages: next.slice(1),
        profile: confirmedProfile(),
      });
      const data = res.data.data as { reply: string; ready: boolean };
      setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
      setReady(!!data.ready);
    } catch (err: any) {
      if (err?.response?.status === 503) {
        setFallback(true);
        return;
      }
      addToast(err?.response?.data?.error?.message || 'Something went wrong. Please try again.', 'error');
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    try {
      await api.post('/onboarding/confirm', {
        messages: messages.slice(1),
        profile: confirmedProfile(),
      });
      await checkSession();
      addToast('Welcome to Reason!', 'success');
      navigate(redirect, { replace: true });
    } catch (err: any) {
      if (err?.response?.status === 503) {
        setFallback(true);
        return;
      }
      addToast(err?.response?.data?.error?.message || 'Could not save just yet. Please try again.', 'error');
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

  // LLM unavailable: fall back to the original form so signup is never blocked.
  if (fallback) return <OnboardingPage />;

  const shellClass = 'flex h-screen flex-col overflow-hidden bg-gradient-to-b from-white to-gray-50/50';

  if (stage === 'loading') {
    return (
      <div className={shellClass} style={{ height: '100dvh' }}>
        <div className="flex flex-1 items-center justify-center">
          <HostPresence size={96} state="thinking" />
        </div>
      </div>
    );
  }

  if (stage === 'confirm') {
    return (
      <div className={shellClass} style={{ height: '100dvh' }}>
        <div
          className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8"
          style={{ paddingTop: 'max(env(safe-area-inset-top), 2rem)', paddingBottom: 'max(env(safe-area-inset-bottom), 2rem)' }}
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex w-full max-w-md flex-col items-center gap-5 text-center"
          >
            <HostPresence size={96} state="idle" />
            <div>
              <h1 className="font-display text-2xl font-semibold leading-snug text-[#1a1a2e]">
                Hi {firstName}. Welcome to Reason.
              </h1>
              <p className="mt-2 text-sm text-gray-500">
                Good to have you here. Here is what we have so far. Is it right?
              </p>
            </div>
            <div className="w-full rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm">
              <ConfirmRow label="Name" value={draft.name} editing={editing} placeholder="Your name" onChange={(v) => setDraft((d) => ({ ...d, name: v }))} />
              <ConfirmRow label="Country" value={draft.country} editing={editing} placeholder="Where you are based" guessed={known?.countryGuessed} onChange={(v) => setDraft((d) => ({ ...d, country: v }))} />
              <ConfirmRow label="Company" value={draft.company} editing={editing} placeholder="Where you work" guessed={known?.companyGuessed} last onChange={(v) => setDraft((d) => ({ ...d, company: v }))} />
            </div>
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              <Button onClick={startChat} className="min-h-[48px] flex-1 justify-center text-base">
                <Check className="mr-1.5 h-4 w-4" /> Yes, continue
              </Button>
              <Button
                variant="secondary"
                onClick={() => setEditing((e) => !e)}
                className="min-h-[48px] flex-1 justify-center text-base"
              >
                <Pencil className="mr-1.5 h-4 w-4" /> {editing ? 'Done' : 'Edit'}
              </Button>
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  // stage === 'chat'
  const firstReply = messages.filter((m) => m.role === 'user').length === 0;
  const placeholder = firstReply ? 'Write your reason here...' : 'Type your reply...';

  return (
    <div className={shellClass} style={{ height: '100dvh' }}>
      <header
        className="flex items-center gap-3 border-b border-gray-100 bg-white/80 px-4 pb-3 backdrop-blur"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}
      >
        <HostPresence size={40} state={sending ? 'thinking' : 'idle'} />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-[#1a1a2e]">Reason</div>
          <div className="text-xs text-gray-400">onboarding</div>
        </div>
      </header>

      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-5">
        {messages.map((m, i) =>
          m.role === 'assistant' ? <HostBubble key={i} text={m.content} /> : <UserBubble key={i} text={m.content} />
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
              <p className="mb-3 text-sm text-[#1a1a2e]">Here is what we understood. Does that capture it?</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={handleConfirm} isLoading={confirming} className="min-h-[48px] flex-1 justify-center text-base">
                  <Check className="mr-1.5 h-4 w-4" /> Yes, use this
                </Button>
                <Button variant="secondary" onClick={handleKeepTalking} disabled={confirming} className="min-h-[48px] flex-1 justify-center text-base">
                  Keep talking
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {!ready && (
        <div
          className="border-t border-gray-200 bg-white px-3 py-3"
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
              placeholder={placeholder}
              aria-label="Your answer"
              autoFocus
              className="max-h-[120px] min-h-[52px] flex-1 resize-none rounded-2xl border-2 border-gray-300 bg-white px-4 py-3 text-base text-[#1a1a2e] placeholder:text-gray-500 focus:border-rsn-red focus:outline-none focus:ring-2 focus:ring-rsn-red/20"
            />
            <Button
              type="submit"
              isLoading={sending}
              disabled={!input.trim()}
              aria-label="Send"
              className="min-h-[52px] min-w-[52px] rounded-2xl !px-3"
            >
              {!sending && <ArrowUp className="h-5 w-5" />}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
