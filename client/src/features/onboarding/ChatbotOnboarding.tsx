import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Check, ChevronDown, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import {
  type OnboardingMessage,
  type OnboardingKnownProfile,
  type OnboardingConfirmedProfile,
  type OnboardingResume,
  type OnboardingOpening,
  type OnboardingStatusResponse,
  type OnboardingEnrichmentCandidate,
  OPENINGS,
} from '@rsn/shared';
import OnboardingPage from './OnboardingPage';
import HostPresence from './HostPresence';

// v1.2 truthful, state-driven onboarding: welcome by name, wait for the
// background enrichment job (server-owned, no client retries), then either
// confirm what it found or build the profile together in chat — the opening
// line always comes from OPENINGS[opening] (the server-derived enrichment
// state, `@rsn/shared`), never a client guess. The follow-up question after
// that opening line still depends on known?.reason (skip it when we already
// have one) — that branch is orthogonal to the opening and unchanged.
// No dashes anywhere (style rule). If the LLM is down we fall back to the form.
const FIRST_QUESTION =
  "Reason works best when we understand why you're here. What is your reason for joining? One sentence is enough.";
// When the member already gave their reason (e.g. in a join request), don't re-ask it —
// acknowledge that we've looked them up, then move straight to what matters for matching.
// Only truthful when the settled opening is 'found' or 'partial' (we genuinely
// have SOME known profile data, whether retrieved or already on file) — see
// REASON_KNOWN_QUESTION_NO_BACKGROUND for the not_found case, where nothing
// was found and claiming a "look at your background" would be a lie.
const REASON_KNOWN_QUESTION =
  "I've had a quick look at your background so we can spend less time on basics, and thanks for sharing why you're here. To match you well, who would be most valuable for you to meet, and roughly why? If I've got anything wrong, just tell me.";
// Same follow-up for when the opening settled not_found: thanks the member for
// the reason they already gave, without claiming any background review that
// never happened.
const REASON_KNOWN_QUESTION_NO_BACKGROUND =
  "Thanks for sharing why you're here. To match you well, who would be most valuable for you to meet, and roughly why?";

// How often the searching stage polls GET /onboarding/status, and the belt
// timeout (server will have terminal-ed long before this) that forces the
// not_found path if polling never resolves.
const STATUS_POLL_MS = 2500;
const SEARCH_BELT_TIMEOUT_MS = 3 * 60 * 1000;

type Stage = 'loading' | 'searching' | 'resume' | 'confirm' | 'chat';

function HostBubble({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="max-w-[85%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md border border-gray-200 bg-white px-4 py-3 text-[15px] leading-relaxed text-[#1a1a2e] shadow-sm md:max-w-[75%]"
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
      className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl rounded-br-md bg-rsn-red px-4 py-3 text-[15px] leading-relaxed text-white shadow-sm md:max-w-[75%]"
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

// Resolve a field that may have been prefilled from a weak known-email-domain guess
// (GET /onboarding/known's *Guessed flags). Priority: member-typed > verified LinkedIn
// candidate > untouched known guess > empty — a draft value still equal to the guess it
// was seeded with hasn't been touched by the member, so the candidate may still replace
// it; any value that differs from that guess was typed by the member and always wins.
function resolveGuessable(
  current: string,
  guessValue: string | null | undefined,
  wasGuessed: boolean | undefined,
  candidateValue: string | null | undefined
): string {
  const untouched = !current || (!!wasGuessed && current === (guessValue || ''));
  return untouched ? candidateValue || current || '' : current;
}

// How complete the card is — drives the progress bar + mobile chips. Counts the
// fields the chat can actually fill (not name/country, which are known upfront).
function cardProgress(d: typeof emptyDraft): { filled: number; total: number } {
  const flags = [!!d.reason, !!d.role, !!d.company, !!d.industry, !!d.about, d.wantsToMeet.length > 0, d.offers.length > 0];
  return { filled: flags.filter(Boolean).length, total: flags.length };
}

// Live profile card shown beside the chat (desktop) — fills in as we enrich + learn.
function ProfileCardPreview({ d, enriched, name }: { d: typeof emptyDraft; enriched: boolean; name: string }) {
  const Row = ({ label, value }: { label: string; value: string }) =>
    value ? (
      // key={value} remounts on change → each fill/update flashes so the member
      // SEES the card react to what they just said.
      <motion.div
        key={value}
        initial={{ backgroundColor: 'rgba(255,122,92,0.18)', opacity: 0.6 }}
        animate={{ backgroundColor: 'rgba(255,122,92,0)', opacity: 1 }}
        transition={{ duration: 1.1, ease: 'easeOut' }}
        className="-mx-2 mb-1.5 rounded-lg px-2 py-1.5"
      >
        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
        <div className="mt-0.5 text-sm leading-relaxed text-[#1a1a2e]">{value}</div>
      </motion.div>
    ) : null;
  const empty = !d.role && !d.company && !d.industry && !d.about && !d.reason && !d.wantsToMeet.length && !d.offers.length;
  const { filled, total } = cardProgress(d);
  return (
    <div className="w-full rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Your profile</span>
        {enriched && <Sparkles className="h-3.5 w-3.5 text-rsn-red" />}
      </div>
      <div className="mb-1 font-display text-xl font-bold text-[#1a1a2e]">{name || 'You'}</div>
      <div className="mb-4">
        <div className="h-1 w-full overflow-hidden rounded-full bg-gray-100">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-rsn-red to-[#ff7a5c]"
            animate={{ width: `${Math.max(6, (filled / total) * 100)}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
        </div>
        <div className="mt-1 text-[11px] text-gray-400">Fills in live as you chat</div>
      </div>
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

// Mobile companion for the desktop side card: a slim tappable strip under the
// header showing live progress, expanding into the full card. Without this,
// phones never see the card populate — the feature's best moment.
function MobileCardStrip({ d, enriched, name }: { d: typeof emptyDraft; enriched: boolean; name: string }) {
  const [open, setOpen] = useState(false);
  const { filled, total } = cardProgress(d);
  return (
    <div className="border-b border-gray-100 bg-white/90 backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2.5 px-4 py-2 text-left"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-rsn-red" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-[#1a1a2e]">
            Your profile · <span className="text-gray-400">{filled ? `${filled} of ${total} filled` : 'fills in as you chat'}</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-gray-100">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-rsn-red to-[#ff7a5c]"
              animate={{ width: `${Math.max(6, (filled / total) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
        </div>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="shrink-0 text-gray-400">
          <ChevronDown className="h-4 w-4" />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="max-h-[45dvh] overflow-y-auto px-4 pb-3">
              <ProfileCardPreview d={d} enriched={enriched} name={name} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
  // Truthful enrichment outcome, read from GET /onboarding/status while in the
  // 'searching' stage — the single source of truth for the opening line and
  // for whether the confirm card shows at all (see settleOpening below). The
  // server job owns retries; the client only ever reads this state.
  const [opening, setOpening] = useState<OnboardingOpening | null>(null);
  const enriched = opening === 'found' || opening === 'partial';

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

  // Fetch what we already know + any in-progress conversation, then route to
  // 'resume' if one exists, otherwise to 'searching' — the enrichment outcome
  // (not raw "do we know anything") now decides confirm vs. chat, so every
  // fresh arrival waits on the status poll below before that decision is made.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [knownRes, resumeRes] = await Promise.allSettled([
        api.get('/onboarding/known'),
        api.get('/onboarding/resume'),
      ]);
      if (cancelled) return;

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

      setStage('searching');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the messages an opening starts with: the truthful OPENINGS[opening]
  // line (server-derived, verbatim), followed by the existing question flow —
  // known?.reason still decides whether the reason question is skipped, which
  // stays orthogonal to the opening itself. The known-reason follow-up's
  // "quick look at your background" claim is only truthful when `op` is found
  // or partial (we genuinely have SOME known profile data); not_found gets the
  // no-background variant so it never claims a review that never happened.
  function openingMessages(op: OnboardingOpening): OnboardingMessage[] {
    const hasBackground = op === 'found' || op === 'partial';
    return [
      { role: 'assistant', content: OPENINGS[op] },
      {
        role: 'assistant',
        content: known?.reason
          ? (hasBackground ? REASON_KNOWN_QUESTION : REASON_KNOWN_QUESTION_NO_BACKGROUND)
          : FIRST_QUESTION,
      },
    ];
  }

  // Land on the right stage for a resolved (non-searching) opening: found/partial
  // seed the confirm card from the enrichment candidate (the found profile —
  // same field mapping the pre-202 runEnrich used) and show it before chat;
  // not_found skips it entirely. Identity fields fill only when empty (never
  // clobber known/edited values); accepting the card persists via startChat's
  // applyFields, exactly like the old accept path.
  function settleOpening(op: OnboardingOpening, candidate?: OnboardingEnrichmentCandidate) {
    setOpening(op);
    if (op === 'found' || op === 'partial') {
      if (candidate) {
        setDraft((d) => ({
          ...d,
          // Priority: member-typed > verified LinkedIn candidate > known email-domain guess > empty.
          // Only `company` has a known-guess counterpart today (known.companyGuessed); role,
          // industry, location, about and linkedin have none, so empty-only fill stays correct.
          company: resolveGuessable(d.company, known?.company, known?.companyGuessed, candidate.currentCompany),
          role: d.role || candidate.currentRole || candidate.headline || '',
          industry: d.industry || candidate.industry || '',
          location: d.location || candidate.location || '',
          about: d.about || candidate.summary || '',
          linkedin: d.linkedin || candidate.linkedinUrl || '',
          // Prefill interests/reasons-to-meet from LinkedIn; chat answers merge on top (prioritized).
          wantsToMeet: d.wantsToMeet.length ? d.wantsToMeet : (Array.isArray(candidate.likelyWantsToMeet) ? candidate.likelyWantsToMeet : []),
          offers: d.offers.length ? d.offers : (Array.isArray(candidate.likelyOffers) ? candidate.likelyOffers : []),
        }));
      }
      setStage('confirm');
    } else {
      setMessages(openingMessages(op));
      setStage('chat');
    }
  }

  // The 'searching' stage: poll GET /onboarding/status every 2.5s until the
  // opening resolves away from 'searching'. Fires the enrichment trigger
  // exactly once per searching-session (only when a LinkedIn URL is on file
  // and no job has ever run THIS session) when status is 'none' (no job has
  // run yet) OR 'failed' (the last run hit a transient provider error, e.g. a
  // free-quota exhaustion that has since been upgraded) — and keeps polling
  // through that first response instead of settling on it (the search it just
  // triggered is still running). A failed enrichment is never a life
  // sentence: this is the ONE retry a member gets per searching-session.
  //
  // Retry-once semantics: once the trigger has fired, a LATER poll reporting
  // 'failed' again means the retry itself concluded in failure, not that this
  // is still the original stale response — settle on it (the normal branch
  // below, using the server's honest opening) rather than looping forever.
  // 'none' stays exempt from that fall-through: as long as status is 'none'
  // the job genuinely hasn't started or reported back yet, so it never
  // settles on its own (the belt below still bounds the wait either way).
  //
  // The background job owns every retry from here; the client never times
  // out a request or swallows a 503 itself. A 3-minute belt forces the
  // not_found path if polling somehow never resolves (server will have
  // terminal-ed long before this fires).
  useEffect(() => {
    if (stage !== 'searching') return;
    let cancelled = false;
    let settled = false;
    let pollInFlight = false;
    let enrichFired = false;
    const startedAtMs = Date.now();

    function finish(op: OnboardingOpening, candidate?: OnboardingEnrichmentCandidate) {
      if (cancelled || settled) return;
      settled = true;
      settleOpening(op, candidate);
    }

    async function poll() {
      if (cancelled || settled || pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await api.get('/onboarding/status');
        if (cancelled || settled) return;
        const data = res.data.data as OnboardingStatusResponse;

        // status 'none' (no job has run YET) or a first-time 'failed' (the
        // last run hit a transient provider error) with a LinkedIn URL on
        // file means it's worth firing the trigger (once) and treating this
        // poll as still-searching. The server maps both to a terminal
        // opening, so settling here would settle on the very response that
        // triggered the search (the approved join-request preload case:
        // cached blob, state columns still 'none') or on a failure that has
        // since been retried. The trigger + cache-first orchestrator move it
        // to a real state within a poll cycle; the belt below still bounds
        // the wait. Only a 'none'/'failed' with NO URL to search, or a
        // 'failed' seen AGAIN after the retry already fired, settles instead.
        const stillUntried =
          data.enrichment.status === 'none' ||
          (data.enrichment.status === 'failed' && !enrichFired);
        if (stillUntried && known?.linkedin) {
          if (!enrichFired) {
            enrichFired = true;
            api.post('/onboarding/enrich', { linkedinUrl: known.linkedin }).catch(() => {});
          }
        } else if (data.opening !== 'searching') {
          finish(data.opening, data.enrichment.candidate);
          return;
        }
      } catch {
        // Transient network hiccup — keep polling; the belt timeout below
        // still guarantees this stage never hangs forever.
      } finally {
        pollInFlight = false;
      }
      if (Date.now() - startedAtMs >= SEARCH_BELT_TIMEOUT_MS) {
        finish('not_found');
      }
    }

    void poll();
    const intervalId = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

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
    setMessages(openingMessages(opening || 'not_found'));
    setStage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function resumeChat() {
    // The saved transcript starts at the member's first reply; the opening
    // question is client-only, so prepend it for display. The 'resume' stage
    // bypasses the searching poll entirely (see the mount effect above), so
    // `opening` is never settled here — there's no basis to claim a background
    // review happened, so this always uses the no-background variant.
    setMessages([
      { role: 'assistant', content: known?.reason ? REASON_KNOWN_QUESTION_NO_BACKGROUND : FIRST_QUESTION },
      ...resumeMessages,
    ]);
    setStage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function startOver() {
    // The 'resume' stage returns before the searching poll ever runs (see the
    // mount effect above), so a fresh member choosing to start over still
    // needs the enrichment-gated confirm/chat decision — route back through
    // 'searching' rather than guessing from raw `known` presence.
    setResumeMessages([]);
    setOpening(null);
    setStage('searching');
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
      const data = res.data.data as { reply: string; ready: boolean };
      setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
      setReady(!!data.ready);
      // Live-populate the card from a SEPARATE extraction call (no time cap) so it
      // fills reliably on EVERY turn without delaying the reply above. Identity
      // fields fill only when empty (don't clobber enrichment/edits); chat-derived
      // fields (about, wants, offers) take the latest, chat-prioritized.
      const full: OnboardingMessage[] = [...next.slice(1), { role: 'assistant', content: data.reply }];
      api
        .post('/onboarding/profile', { messages: full }, { timeout: 30000 })
        .then((pr) => {
          const lp = pr.data.data?.profile;
          if (!lp) return;
          setDraft((d) => ({
            ...d,
            role: d.role || lp.role || '',
            company: d.company || lp.company || '',
            industry: d.industry || lp.industry || '',
            location: d.location || lp.location || '',
            about: lp.about || d.about || '',
            wantsToMeet: Array.isArray(lp.wantsToMeet) && lp.wantsToMeet.length ? mergePrioritized(lp.wantsToMeet, d.wantsToMeet) : d.wantsToMeet,
            offers: Array.isArray(lp.offers) && lp.offers.length ? mergePrioritized(lp.offers, d.offers) : d.offers,
          }));
        })
        .catch(() => {});
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

  // Waiting on the background enrichment job (GET /onboarding/status polling,
  // see the effect above). Calm, non-interactive — no dead ends, it always
  // resolves on its own (found/partial/not_found), belt-timed at 3 minutes.
  if (stage === 'searching') {
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
            <HostPresence size={104} state="thinking" />
            <div>
              <h1 className="font-display text-2xl font-semibold leading-snug text-[#1a1a2e]">
                {welcomeLine}, {firstName}.
              </h1>
              <p className="mt-2 text-sm text-gray-500">{OPENINGS.searching}</p>
            </div>
          </motion.div>
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
            {/* This card only ever shows for a resolved found/partial opening (see
                settleOpening) — enrichment is already terminal by now, so the
                message is a simple truthful hint, not a spinner or a re-fetch. */}
            <div className="flex w-full items-center justify-center gap-1.5 text-xs text-gray-500">
              <Sparkles className="h-3.5 w-3.5 text-rsn-red" />
              {opening === 'found'
                ? 'Filled from your public profile — edit anything that\'s off.'
                : 'We found part of your public profile — please fill in the rest below.'}
            </div>
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
      <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-r border-gray-100 bg-gray-50/40 p-5 lg:flex xl:w-96">
        <ProfileCardPreview d={draft} enriched={enriched} name={(draft.name || firstName).trim()} />
      </aside>
      <div className={`${shellClass} min-w-0 flex-1`}>
      <header
        className="border-b border-gray-100 bg-white/80 px-4 pb-3 backdrop-blur"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)' }}
      >
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
          <HostPresence size={40} state={sending ? 'thinking' : 'idle'} />
          <div className="leading-tight">
            <div className="text-sm font-semibold text-[#1a1a2e]">Reason</div>
            <div className="text-xs text-gray-400">onboarding · about 2 min</div>
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
        </div>
      </header>

      <MobileCardStrip d={draft} enriched={enriched} name={(draft.name || firstName).trim()} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
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
            className="mx-auto flex w-full max-w-2xl items-end gap-2"
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
