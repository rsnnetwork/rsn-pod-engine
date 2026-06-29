import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Check, Pencil, RotateCcw, Sparkles, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import {
  type OnboardingMessage,
  type OnboardingKnownProfile,
  type OnboardingConfirmedProfile,
  type OnboardingResume,
} from '@rsn/shared';
import OnboardingPage from './OnboardingPage';
import HostPresence from './HostPresence';

// v1.1 staged onboarding: welcome by name + confirm what we already know, then a
// short chat (the host knows the confirmed profile so it never re-asks), then a
// summary and save. The first chat question mirrors FIRST_QUESTION on the server.
// No dashes anywhere (style rule). If the LLM is down we fall back to the form.
const FIRST_QUESTION =
  "Reason works best when we understand why you're here. What is your reason for joining? One sentence is enough.";
// When the member already gave their reason (e.g. in a join request), don't re-ask it —
// acknowledge it and move straight to the next thing we need for matching.
const OPENING_WITH_REASON =
  "Good to have you here, and thanks for sharing why you're here. To match you well, who would be most valuable for you to meet, and roughly why?";

type Stage = 'loading' | 'resume' | 'confirm' | 'chat';

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
        {!editing && guessed && value ? (
          <span className="ml-1.5 normal-case text-gray-400">(a guess, fix if wrong)</span>
        ) : null}
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

const emptyDraft = { name: '', country: '', reason: '', company: '', role: '', linkedin: '', industry: '', location: '', about: '', wantsToMeet: [] as string[], offers: [] as string[] };

// Merge two string lists — primary first (prioritized), de-duplicated case-insensitively.
// The member's chat answers rank above the LinkedIn-inferred prefill, and nothing is lost.
function mergePrioritized(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...(primary || []), ...(secondary || [])]) {
    const k = (x || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

// Live profile card shown beside the chat (desktop) — fills in as we enrich + learn.
function ProfileCardPreview({ d, enriched, name }: { d: typeof emptyDraft; enriched: boolean; name: string }) {
  const Row = ({ label, value }: { label: string; value: string }) =>
    value ? (
      <div className="mb-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
        <div className="mt-0.5 text-sm leading-relaxed text-[#1a1a2e]">{value}</div>
      </div>
    ) : null;
  const empty = !d.role && !d.company && !d.industry && !d.about && !d.reason && !d.wantsToMeet.length && !d.offers.length;
  return (
    <div className="w-full rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Your profile</span>
        {enriched && <Sparkles className="h-3.5 w-3.5 text-rsn-red" />}
      </div>
      <div className="mb-4 font-display text-xl font-bold text-[#1a1a2e]">{name || 'You'}</div>
      <Row label="Why you're here" value={d.reason} />
      <Row label="Role" value={d.role} />
      <Row label="Company" value={d.company} />
      <Row label="Industry" value={d.industry} />
      <Row label="Location" value={d.location || d.country} />
      <Row label="About" value={d.about} />
      {d.wantsToMeet.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Looking to meet</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {d.wantsToMeet.map((w, i) => (
              <span key={i} className="rounded-full bg-rsn-red-light/50 px-2 py-0.5 text-xs text-[#1a1a2e]">{w}</span>
            ))}
          </div>
        </div>
      )}
      {d.offers.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Can offer</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {d.offers.map((o, i) => (
              <span key={i} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{o}</span>
            ))}
          </div>
        </div>
      )}
      {d.linkedin && (
        <a href={d.linkedin} target="_blank" rel="noreferrer" className="text-xs font-medium text-rsn-red underline">
          LinkedIn
        </a>
      )}
      {empty && <p className="text-sm text-gray-400">This fills in as we learn about you.</p>}
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
  const [draft, setDraft] = useState({ ...emptyDraft });
  const [resumeMessages, setResumeMessages] = useState<OnboardingMessage[]>([]);

  const [messages, setMessages] = useState<OnboardingMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [finishAttempts, setFinishAttempts] = useState(0);
  // Profile enrichment — pull public profile data + populate the card the user watches.
  const [enriching, setEnriching] = useState(false);
  const [enriched, setEnriched] = useState(false);
  const [candidate, setCandidate] = useState<any | null>(null); // no-LinkedIn "is this you?" result
  const enrichTriggered = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const u = user as any;
  const firstName =
    known?.firstName ||
    (known?.name ? known.name.split(/\s+/)[0] : '') ||
    u?.firstName ||
    (u?.displayName ? u.displayName.split(/\s+/)[0] : '') ||
    'there';
  const welcomeLine = (known?.previousEvents ?? 0) > 0 ? 'Welcome back to Reason' : 'Welcome to Reason';

  // Fetch what we already know + any in-progress conversation, then route to the
  // right opening stage (resume / confirm / chat).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [knownRes, resumeRes] = await Promise.allSettled([
        api.get('/onboarding/known'),
        api.get('/onboarding/resume'),
      ]);
      if (cancelled) return;

      let haveKnown = false;
      if (knownRes.status === 'fulfilled') {
        const k = knownRes.value.data.data as OnboardingKnownProfile;
        setKnown(k);
        setDraft({
          name: k.name || '',
          country: k.country || '',
          reason: k.reason || '',
          company: k.company || '',
          role: k.role || '',
          linkedin: k.linkedin || '',
          industry: '',
          location: '',
          about: '',
          wantsToMeet: [],
          offers: [],
        });
        haveKnown = true;
      }

      // Offer to resume only when there's a real in-progress exchange.
      if (resumeRes.status === 'fulfilled') {
        const r = resumeRes.value.data.data as OnboardingResume;
        const saved = Array.isArray(r.messages) ? r.messages : [];
        if (r.status === 'in_progress' && saved.some((m) => m.role === 'user')) {
          setResumeMessages(saved);
          setStage('resume');
          return;
        }
      }

      if (haveKnown) {
        setStage('confirm');
      } else {
        setMessages([{ role: 'assistant', content: known?.reason ? OPENING_WITH_REASON : FIRST_QUESTION}]);
        setStage('chat');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-enrich once we know the member: if they already have a LinkedIn on file,
  // pull their profile immediately so the card populates as they arrive.
  useEffect(() => {
    if (!known || enrichTriggered.current) return;
    if (known.linkedin) {
      // LinkedIn on file → high-confidence auto-fill.
      enrichTriggered.current = true;
      void runEnrich(known.linkedin);
    } else if (known.name && (known.company || known.country)) {
      // No LinkedIn → search by name + company + country, then ask "is this you?"
      enrichTriggered.current = true;
      void runDiscover();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known]);

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
      role: draft.role.trim() || null,
      linkedin: draft.linkedin.trim() || null,
    };
  }

  // Persist confirmed/enriched fields to the real profile. Background-safe — runs
  // whenever a result lands, even if the member has already continued to chat.
  function applyFields(f: {
    jobTitle?: string | null;
    company?: string | null;
    industry?: string | null;
    location?: string | null;
    bio?: string | null;
    linkedin?: string | null;
  }) {
    api.post('/onboarding/enrich/apply', f, { timeout: 20000 }).catch(() => {});
  }

  // Pull the member's public profile (their LinkedIn URL if we have one, else
  // name + company + country) and fill the card they're watching. Runs in the
  // BACKGROUND — the member can keep going; the result lands when it's ready.
  async function runEnrich(linkedinUrl?: string) {
    if (enriching) return;
    setEnriching(true);
    try {
      const res = await api.post('/onboarding/enrich', { linkedinUrl: linkedinUrl || draft.linkedin || null }, { timeout: 70000 });
      const r = res.data.data as { profile: any; confidence: number } | null;
      if (r?.profile && r.confidence >= 0.35) {
        const p = r.profile;
        setDraft((d) => ({
          ...d,
          company: d.company || p.currentCompany || '',
          role: d.role || p.currentRole || p.headline || '',
          industry: d.industry || p.industry || '',
          location: d.location || p.location || '',
          about: d.about || p.summary || '',
          linkedin: d.linkedin || p.linkedinUrl || linkedinUrl || '',
          // Prefill interests/reasons-to-meet from LinkedIn; chat answers merge on top (prioritized).
          wantsToMeet: d.wantsToMeet.length ? d.wantsToMeet : (Array.isArray(p.likelyWantsToMeet) ? p.likelyWantsToMeet : []),
          offers: d.offers.length ? d.offers : (Array.isArray(p.likelyOffers) ? p.likelyOffers : []),
        }));
        setEnriched(true);
        // Background-save so the profile is populated even if they've moved to chat.
        applyFields({
          jobTitle: p.currentRole || p.headline || null,
          company: p.currentCompany || null,
          industry: p.industry || null,
          location: p.location || null,
          bio: p.summary || null,
          linkedin: p.linkedinUrl || linkedinUrl || null,
        });
      } else {
        addToast("We couldn't find a confident match — fill in what you can.", 'info');
      }
    } catch (err: any) {
      if (err?.response?.status !== 503) addToast('Auto-fill is unavailable right now.', 'error');
    } finally {
      setEnriching(false);
    }
  }

  // No-LinkedIn discovery: search by name + company + country and, because this is
  // lower-confidence than a LinkedIn match, present the result as "is this you?"
  // rather than filling silently.
  async function runDiscover() {
    if (enriching) return;
    setEnriching(true);
    try {
      const res = await api.post('/onboarding/enrich', { linkedinUrl: null }, { timeout: 70000 });
      const r = res.data.data as { profile: any; confidence: number; foundLinkedinUrl?: string } | null;
      if (r?.profile && r.confidence >= 0.35) setCandidate(r);
      // Low confidence / no match → stay quiet; they can fill in or add a LinkedIn.
    } catch {
      /* best-effort — never block onboarding */
    } finally {
      setEnriching(false);
    }
  }

  // Member confirmed the discovered candidate is them → fill the card from it.
  function acceptCandidate() {
    const p = candidate?.profile;
    if (!p) return;
    setDraft((d) => ({
      ...d,
      company: d.company || p.currentCompany || '',
      role: d.role || p.currentRole || p.headline || '',
      industry: d.industry || p.industry || '',
      location: d.location || p.location || '',
      about: d.about || p.summary || '',
      linkedin: d.linkedin || p.linkedinUrl || candidate?.foundLinkedinUrl || '',
      wantsToMeet: d.wantsToMeet.length ? d.wantsToMeet : (Array.isArray(p.likelyWantsToMeet) ? p.likelyWantsToMeet : []),
      offers: d.offers.length ? d.offers : (Array.isArray(p.likelyOffers) ? p.likelyOffers : []),
    }));
    setEnriched(true);
    applyFields({
      jobTitle: p.currentRole || p.headline || null,
      company: p.currentCompany || null,
      industry: p.industry || null,
      location: p.location || null,
      bio: p.summary || null,
      linkedin: p.linkedinUrl || candidate?.foundLinkedinUrl || null,
    });
    setCandidate(null);
  }

  function rejectCandidate() {
    setCandidate(null);
  }

  function startChat() {
    // Persist whatever the member confirmed/edited (background-safe).
    applyFields({
      jobTitle: draft.role.trim() || null,
      company: draft.company.trim() || null,
      industry: draft.industry.trim() || null,
      location: (draft.location || draft.country).trim() || null,
      bio: draft.about.trim() || null,
      linkedin: draft.linkedin.trim() || null,
    });
    setEditing(false);
    setMessages([{ role: 'assistant', content: known?.reason ? OPENING_WITH_REASON : FIRST_QUESTION}]);
    setStage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function resumeChat() {
    // The saved transcript starts at the member's first reply; the opening
    // question is client-only, so prepend it for display.
    setMessages([{ role: 'assistant', content: known?.reason ? OPENING_WITH_REASON : FIRST_QUESTION}, ...resumeMessages]);
    setStage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function startOver() {
    setResumeMessages([]);
    setStage(known ? 'confirm' : 'chat');
    if (!known) {
      setMessages([{ role: 'assistant', content: FIRST_QUESTION }]);
    }
  }

  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  // One host turn. wrapMode drives the "I'm done" control: 'soft' lets the host
  // ask one last skippable thing if it's missing what the member offers; 'hard'
  // wraps up unconditionally.
  async function sendTurn(next: OnboardingMessage[], wrapMode: 'none' | 'soft' | 'hard' = 'none') {
    setReady(false);
    setSending(true);
    try {
      const res = await api.post('/onboarding/chat', {
        messages: next.slice(1),
        profile: confirmedProfile(),
        finish: wrapMode === 'soft',
        hardFinish: wrapMode === 'hard',
      });
      const data = res.data.data as { reply: string; ready: boolean; profile?: any };
      setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
      setReady(!!data.ready);
      // Live-populate the profile card from the per-turn extraction. Identity
      // fields fill only when empty (don't clobber enrichment/edits); the
      // chat-derived fields (about, wants, offers) take the latest.
      const lp = data.profile;
      if (lp) {
        setDraft((d) => ({
          ...d,
          role: d.role || lp.role || '',
          company: d.company || lp.company || '',
          industry: d.industry || lp.industry || '',
          location: d.location || lp.location || '',
          about: lp.about || d.about || '',
          // Chat answers prioritized first, LinkedIn-inferred prefill kept underneath (deduped).
          wantsToMeet: Array.isArray(lp.wantsToMeet) && lp.wantsToMeet.length ? mergePrioritized(lp.wantsToMeet, d.wantsToMeet) : d.wantsToMeet,
          offers: Array.isArray(lp.offers) && lp.offers.length ? mergePrioritized(lp.offers, d.offers) : d.offers,
        }));
      }
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

  async function handleSend() {
    const text = input.trim();
    if (!text || sending || confirming) return;
    const next: OnboardingMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.style.height = 'auto';
    });
    await sendTurn(next, 'none');
  }

  async function handleFinish() {
    if (sending || confirming) return;
    if (!messages.some((m) => m.role === 'user')) return; // nothing to wrap up yet
    // Append a short closing user turn so the host has a member message to respond
    // to (the model needs the last turn to be the member). First press is a soft
    // finish (host may ask one last skippable thing if it's still missing what the
    // member offers); a second press wraps up hard.
    const hard = finishAttempts >= 1;
    setFinishAttempts((n) => n + 1);
    const next: OnboardingMessage[] = [
      ...messages,
      { role: 'user', content: hard ? 'Let us wrap up now.' : 'I think that is everything for now.' },
    ];
    setMessages(next);
    await sendTurn(next, hard ? 'hard' : 'soft');
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

  function handleEditAnswers() {
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

  if (stage === 'resume') {
    return (
      <div className={shellClass} style={{ height: '100dvh' }}>
        <div
          className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8"
          style={{ paddingTop: 'max(env(safe-area-inset-top), 2rem)', paddingBottom: 'max(env(safe-area-inset-bottom), 2rem)' }}
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="flex w-full max-w-md flex-col items-center gap-5 text-center"
          >
            <HostPresence size={96} state="idle" />
            <div>
              <h1 className="font-display text-2xl font-semibold leading-snug text-[#1a1a2e]">
                Welcome back, {firstName}.
              </h1>
              <p className="mt-2 text-sm text-gray-500">
                You already started telling us your reason. Want to pick up where you left off?
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              <Button onClick={resumeChat} className="min-h-[48px] flex-1 justify-center text-base">
                <Check className="mr-1.5 h-4 w-4" /> Continue
              </Button>
              <Button
                variant="secondary"
                onClick={startOver}
                className="min-h-[48px] flex-1 justify-center text-base"
              >
                <RotateCcw className="mr-1.5 h-4 w-4" /> Start over
              </Button>
            </div>
          </motion.div>
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
            <HostPresence size={104} state="idle" />
            <div className="flex flex-col items-center gap-1">
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.15, duration: 0.4 }}
                className="text-base font-medium tracking-wide text-gray-500"
              >
                {welcomeLine}
              </motion.p>
              <motion.h1
                key={(draft.name || firstName).trim()}
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ delay: 0.25, type: 'spring', stiffness: 150, damping: 15 }}
                className="bg-gradient-to-r from-rsn-red to-[#ff7a5c] bg-clip-text font-display text-3xl font-extrabold leading-tight text-transparent sm:text-4xl"
              >
                {(draft.name || firstName || 'there').trim()}
              </motion.h1>
              <p className="mt-2 text-sm text-gray-500">
                Good to have you here. Here is what we have so far. Is it right?
              </p>
            </div>
            <div className="w-full rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm">
              <ConfirmRow label="Name" value={draft.name} editing={editing} placeholder="Your name" guessed={known?.nameGuessed} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} />
              <ConfirmRow label="Country" value={draft.country} editing={editing} placeholder="Where you are based" guessed={known?.countryGuessed} onChange={(v) => setDraft((d) => ({ ...d, country: v }))} />
              <ConfirmRow label="Reason for joining" value={draft.reason} editing={editing} placeholder="Why you're here" onChange={(v) => setDraft((d) => ({ ...d, reason: v }))} />
              <ConfirmRow label="Company" value={draft.company} editing={editing} placeholder="Where you work" guessed={known?.companyGuessed} onChange={(v) => setDraft((d) => ({ ...d, company: v }))} />
              <ConfirmRow label="Role" value={draft.role} editing={editing} placeholder="Your role or title" onChange={(v) => setDraft((d) => ({ ...d, role: v }))} />
              <ConfirmRow label="LinkedIn" value={draft.linkedin} editing={editing} placeholder="Your LinkedIn URL" onChange={(v) => setDraft((d) => ({ ...d, linkedin: v }))} />
              <ConfirmRow label="Industry" value={draft.industry} editing={editing} placeholder="Your industry" onChange={(v) => setDraft((d) => ({ ...d, industry: v }))} />
              <ConfirmRow label="About" value={draft.about} editing={editing} placeholder="A short professional summary" last onChange={(v) => setDraft((d) => ({ ...d, about: v }))} />
            </div>
            {enriching ? (
              <div className="flex w-full items-center justify-center gap-2 text-sm text-rsn-red">
                <Loader2 className="h-4 w-4 animate-spin" /> We're getting your details — your card will be ready shortly. Feel free to start the chat meanwhile.
              </div>
            ) : candidate?.profile ? (
              <div className="w-full rounded-2xl border-2 border-rsn-red/30 bg-rsn-red-light/20 p-4 text-left">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[#1a1a2e]">
                  <Sparkles className="h-4 w-4 text-rsn-red" /> Is this you?
                </div>
                <div className="font-semibold text-[#1a1a2e]">{candidate.profile.fullName || draft.name}</div>
                {candidate.profile.headline && <div className="text-sm text-gray-600">{candidate.profile.headline}</div>}
                {(candidate.profile.currentRole || candidate.profile.currentCompany) && (
                  <div className="mt-0.5 text-sm text-gray-600">
                    {[candidate.profile.currentRole, candidate.profile.currentCompany].filter(Boolean).join(' at ')}
                  </div>
                )}
                {candidate.profile.location && <div className="text-xs text-gray-500">{candidate.profile.location}</div>}
                {candidate.foundLinkedinUrl && (
                  <a
                    href={candidate.foundLinkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block break-all text-xs text-rsn-red underline"
                  >
                    {candidate.foundLinkedinUrl}
                  </a>
                )}
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button onClick={acceptCandidate} className="min-h-[44px] flex-1 justify-center text-sm">
                    <Check className="mr-1.5 h-4 w-4" /> Yes, that's me
                  </Button>
                  <Button variant="secondary" onClick={rejectCandidate} className="min-h-[44px] flex-1 justify-center text-sm">
                    Not me
                  </Button>
                </div>
              </div>
            ) : enriched ? (
              <div className="flex w-full items-center justify-center gap-1.5 text-xs text-gray-500">
                <Sparkles className="h-3.5 w-3.5 text-rsn-red" /> Filled from your public profile — edit anything that's off.
              </div>
            ) : (
              <button
                type="button"
                onClick={() => runEnrich(draft.linkedin)}
                disabled={!draft.linkedin.trim()}
                className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-rsn-red/30 px-3 text-sm font-medium text-rsn-red transition-colors hover:bg-rsn-red-light/40 disabled:opacity-40"
              >
                <Sparkles className="h-4 w-4" /> {draft.linkedin.trim() ? 'Auto-fill from my LinkedIn' : 'Add your LinkedIn above to auto-fill'}
              </button>
            )}
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              {/* Non-blocking: the lookup runs in the background, so continuing is always allowed. */}
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
  const hasUserReply = messages.some((m) => m.role === 'user');
  const placeholder = hasUserReply ? 'Type your reply...' : 'Write your reason here...';

  return (
    <div className="flex overflow-hidden bg-gradient-to-b from-white to-gray-50/50" style={{ height: '100dvh' }}>
      <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-r border-gray-100 bg-gray-50/40 p-5 lg:flex">
        <ProfileCardPreview d={draft} enriched={enriched} name={(draft.name || firstName).trim()} />
      </aside>
      <div className={`${shellClass} min-w-0 flex-1`}>
      <header
        className="flex items-center gap-3 border-b border-gray-100 bg-white/80 px-4 pb-3 backdrop-blur"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}
      >
        <HostPresence size={40} state={sending ? 'thinking' : 'idle'} />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-[#1a1a2e]">Reason</div>
          <div className="text-xs text-gray-400">onboarding</div>
        </div>
        {hasUserReply && !ready && (
          <button
            type="button"
            onClick={handleFinish}
            disabled={sending}
            className="ml-auto min-h-[44px] rounded-lg px-3 text-sm font-medium text-gray-400 transition-colors hover:text-rsn-red disabled:opacity-50"
          >
            I'm done
          </button>
        )}
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
              <p className="mb-3 text-sm text-[#1a1a2e]">
                Here is how we understand you, just above. Should we use this for your matching?
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={handleConfirm} isLoading={confirming} className="min-h-[48px] flex-1 justify-center text-base">
                  <Check className="mr-1.5 h-4 w-4" /> Yes, use this
                </Button>
                <Button variant="secondary" onClick={handleEditAnswers} disabled={confirming} className="min-h-[48px] flex-1 justify-center text-base">
                  <Pencil className="mr-1.5 h-4 w-4" /> Edit
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
    </div>
  );
}
