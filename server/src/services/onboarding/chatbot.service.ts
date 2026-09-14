// ─── Onboarding Chatbot Service ──────────────────────────────────────────────
//
// Wraps the two Claude calls behind one service so the model, streaming, and
// prompts are all swappable in one place:
//   converse()      — Claude call #1: one warm host turn (per user message).
//   extractIntent() — Claude call #2: structured JSON extraction at confirm.
//
// The Anthropic client is created lazily and only when a key is configured.
// isEnabled() lets the routes fall back to the minimal form when no key is set,
// so onboarding (and signup) is never blocked by a missing/expired key.

import Anthropic from '@anthropic-ai/sdk';
import logger from '../../config/logger';
import config from '../../config';
import { withBalanceAlert } from './llm-balance-alert';
import { OnboardingMessage, OnboardingConfirmedProfile, OnboardingOpening } from '@rsn/shared';
import { IntentSchema, INTENT_JSON_SCHEMA, ExtractedIntent } from './intent.schema';
import {
  buildHostSystemPrompt,
  EXTRACTION_PROMPT,
  READY_TOKEN,
  serializeConversation,
  serializeKnownForExtraction,
  type ExtractionKnown,
  type HostKnownExtra,
  type HostProgress,
} from './prompts';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    client = withBalanceAlert(new Anthropic({ apiKey: config.anthropicApiKey }));
  }
  return client;
}

/** True when an Anthropic key is configured — gates the chat vs. form fallback. */
export function isEnabled(): boolean {
  return !!config.anthropicApiKey;
}

/**
 * Claude call #1 — one host turn. Returns the reply plus `ready`, which flips
 * true once the host has summarised and emitted the silent READY_TOKEN (stripped
 * from the reply the user sees).
 *
 * `effectiveOpening` drives the honesty clause and MUST be the same effective
 * opening GET /onboarding/status reports (openingFromEnrichment + the
 * hasSubstantiveProfileData Claus rule), not the raw enrichment status — the
 * caller (POST /onboarding/chat) resolves it before calling in, so the system
 * prompt can never contradict what the client's opening bubble already told
 * the member.
 */
/**
 * 7 Sep 2026 (Ali: "it must be easy to talk and to the point"). The rules the
 * model still breaks now and then even when told: a two-part question, an
 * "A or B?" question, a comment with no question, reading the answer back,
 * or simply too many words. Returns the names of the rules a draft breaks so
 * the host can be asked once to rewrite it. Exported for the tests.
 */
export function styleViolations(text: string, ready: boolean): string[] {
  const body = text.replace(READY_TOKEN, '').trim();
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const out: string[] = [];
  if (ready) {
    if (wordCount > 40) out.push('the summary is over 30 words');
    // 14 Sep 2026 (Shradha): a closing is a statement. A question sent with
    // the token hid the composer and left the member unable to answer it.
    if (asksQuestion(body)) out.push('the closing asks a question');
    return out;
  }
  const questions = (body.match(/\?/g) || []).length;
  if (questions === 0) out.push('it asks no question');
  if (questions > 1) out.push('it asks more than one question');
  // 10 Sep 2026 (Claus): a one-line reflection plus the question needs ~30.
  if (wordCount > 34) out.push('it is over 30 words');
  const question = body.split(/(?<=[.!])\s+/).find((s) => s.includes('?')) || '';
  if (/\bor\b/i.test(question)) out.push('the question offers alternatives joined by "or"');
  const afterReaction = body.replace(/^\s*[^.!?]{0,24}[.!]\s*/, '');
  if (/^\s*(so you|you're |you are |you want |sounds like|it sounds like)/i.test(afterReaction)) {
    out.push('it reads their answer back to them');
  }
  return out;
}

// ─── A closing is a statement (14 Sep 2026) ──────────────────────────────────
// Shradha's chat: the route forced the wrap after two one-word answers, and
// the model kept the token but sent a question with it ("What's the challenge
// with the blogs at the moment?" + READY). ready=true hides the composer, so
// she saw a question next to "Yes, use this" and "Edit" with no way to answer
// it. A ready turn never carries a question, whichever path produced it.

/** What the host says when it would not write a closing of its own. Claus's
 *  own wording for a thin chat: go with what they gave us, more whenever they like. */
export const DEFAULT_CLOSING = 'We will go with what you have told us so far, and you can tell us more whenever you like.';

export function asksQuestion(text: string): boolean {
  return text.replace(READY_TOKEN, '').includes('?');
}

/** The statement sentences of a draft; a draft with none becomes the default closing. */
export function closingStatement(text: string): string {
  const kept = text
    .replace(READY_TOKEN, '')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0 && !s.includes('?'));
  return kept.join(' ').trim() || DEFAULT_CLOSING;
}

type Turn = { reply: string; ready: boolean };
const isClosing = (t: Turn): boolean => t.ready && !asksQuestion(t.reply);
/** A ready turn goes out as a statement, whatever the model wrote. */
const asStatement = (t: Turn): Turn => (t.ready && asksQuestion(t.reply) ? { reply: closingStatement(t.reply), ready: true } : t);

async function askHost(
  system: string,
  messages: OnboardingMessage[],
): Promise<{ reply: string; ready: boolean }> {
  const anthropic = getClient();
  const resp = await anthropic.messages.create({
    model: config.onboardingChatModel,
    max_tokens: 1024,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  let text = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  // 7 Sep 2026 (Stefan saw "Ready"): the model does not always emit the exact
  // <<READY>> literal. Detect + strip bracket variants (<READY>, << ready >>,
  // **<<READY>>**) and a bare trailing "READY" line, WITHOUT mistaking the
  // ordinary word "ready" inside a sentence for the token.
  const READY_BRACKET = /<{1,2}\s*ready\s*>{1,2}/i;                       // <READY>, << ready >>
  const READY_BARE_TAIL = /(?:^|\n)[^\S\n]*\**\[?[^\S\n]*ready[^\S\n]*\]?\**[^\S\n]*$/i; // final line that is only "ready"/[READY]/**READY**
  const ready = READY_BRACKET.test(text) || READY_BARE_TAIL.test(text);
  if (ready) {
    text = text
      .replace(new RegExp(READY_BRACKET.source, 'gi'), '')
      .replace(READY_BARE_TAIL, '')
      .replace(/\*\*\s*\*\*/g, '')
      .trim();
  }
  // 7 Sep 2026: a reply that is only the ready token (or nothing) left an
  // empty assistant message in the transcript, and every later call
  // (/chat, /profile, /confirm) then failed validation on it: the member
  // pressed "Yes, use this" and nothing happened. Never return empty text.
  if (!text) text = ready ? 'Thank you, that is everything we need.' : 'Could you tell us a bit more?';
  return { reply: text, ready };
}

export async function converse(
  messages: OnboardingMessage[],
  profile?: OnboardingConfirmedProfile,
  wrapMode: 'none' | 'soft' | 'hard' = 'none',
  extra?: HostKnownExtra,
  effectiveOpening?: OnboardingOpening,
  progress?: HostProgress,
): Promise<{ reply: string; ready: boolean }> {
  const system = buildHostSystemPrompt(profile, wrapMode, extra, effectiveOpening, progress);
  const first = await askHost(system, messages);
  // 11 Sep 2026 (Ali's chat): at the question cap the model asked a seventh
  // question anyway. A hard wrap is the server's decision, not the model's:
  // ask once more for the closing only; if it still will not close, close
  // for it (drop every question and mark the turn ready).
  // 14 Sep 2026 (Shradha): "closed" means a statement. A draft that carries
  // the token AND a question has not closed either.
  if (wrapMode === 'hard' && !isClosing(first)) {
    logger.warn({ draft: first.reply.slice(0, 160) }, 'onboarding host: ignored the hard wrap, asking for the closing only');
    let closing = first;
    try {
      closing = await askHost(
        system + `\n\nCLOSING ONLY. You have asked everything you may ask. Do not ask a question. Write the closing summary now in one or two warm sentences, naming the kind of person we will look for (if there is little, say we will go with what they gave us and they can tell us more whenever they like), then the token ${READY_TOKEN} on its own final line.`,
        messages,
      );
    } catch (err) {
      logger.warn({ err }, 'onboarding host: closing call failed, closing with the first draft');
    }
    if (isClosing(closing)) return closing;
    return { reply: closingStatement(closing.reply), ready: true };
  }
  const broken = styleViolations(first.reply, first.ready);
  if (broken.length === 0) return first;

  // One corrective rewrite. If that is no better, the first draft still goes
  // out: a slightly long message beats a stalled chat. A closing that asks
  // something is the one thing that never goes out as written.
  logger.warn({ broken, draft: first.reply.slice(0, 160) }, 'onboarding host: draft broke the style rules, asking for a rewrite');
  try {
    const rewriteSystem = system +
      '\n\nREWRITE. Your previous draft was:\n"' + first.reply.replace(/"/g, "'") + '"\nIt broke these rules: ' + broken.join('; ') +
      (first.ready
        ? `. Write the closing again: reflect what you understood in one or two warm sentences, under 30 words in total, with no question at all, then keep the token ${READY_TOKEN} on its own final line. Reply with the message only.`
        : '. Write the message again so it follows every style rule: no reading their answer back, at most one reflection as a statement, exactly one question of at most 15 words with no "or" in it, under 30 words in total. Reply with the message only.');
    const second = await askHost(rewriteSystem, messages);
    const stillBroken = styleViolations(second.reply, second.ready);
    if (stillBroken.length < broken.length) return asStatement(second);
    logger.warn({ stillBroken }, 'onboarding host: rewrite was no better, sending the first draft');
  } catch (err) {
    logger.warn({ err }, 'onboarding host: rewrite call failed, sending the first draft');
  }
  return asStatement(first);
}

/**
 * Claude call #2 — structured extraction. The JSON contract travels IN the
 * prompt (schema text + a strict output instruction) and the reply is parsed
 * tolerantly, then validated against IntentSchema (zod) so a malformed payload
 * throws instead of corrupting the profile.
 *
 * Deliberately NOT `output_config.format`: the 35-field schema exceeds the
 * API's structured-output grammar compiler limit and every request 400s with
 * "The compiled grammar is too large" — a failure only real calls surface
 * (tests mock the SDK). Do not reintroduce a grammar here without proving one
 * real API call succeeds with the full current schema.
 */
const EXTRACTION_OUTPUT_CONTRACT = `

Output contract:
Respond with ONLY a single JSON object and nothing else — no prose, no markdown fences. It must match this JSON Schema exactly (every key present; use [] / "" / false / null as the rules above describe):
${JSON.stringify(INTENT_JSON_SCHEMA)}

`;

/** Pull the JSON object out of a model reply that may carry fences or prose. */
function parseModelJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // fall through to the shared error below
      }
    }
    throw new Error('Onboarding extraction returned invalid JSON');
  }
}

export async function extractIntent(
  messages: OnboardingMessage[],
  known?: ExtractionKnown | null,
): Promise<ExtractedIntent> {
  const anthropic = getClient();
  const resp = await anthropic.messages.create({
    model: config.onboardingExtractModel,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        // 14 Sep 2026: the facts we already hold (LinkedIn + the request) ride
        // along after the conversation, so a two-word chat still extracts a
        // known person. Empty block when we hold nothing.
        content: EXTRACTION_PROMPT + serializeConversation(messages) + serializeKnownForExtraction(known) + EXTRACTION_OUTPUT_CONTRACT,
      },
    ],
  });

  const raw = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (!raw) {
    throw new Error('Onboarding extraction returned no content');
  }

  return IntentSchema.parse(parseModelJson(raw));
}

// ─── Live profile snapshot ───────────────────────────────────────────────────
// A light view of the running extraction for the onboarding card to populate as
// the member talks (returned by /chat each turn).
export interface LiveProfile {
  role: string | null;
  company: string | null;
  industry: string | null;
  location: string | null;
  about: string | null;
  wantsToMeet: string[];
  offers: string[];
}
export function liveProfileFromIntent(i: ExtractedIntent): LiveProfile {
  const s = (v?: string | null) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const a = (v?: string[] | null) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim().length > 0) : []);
  return {
    role: s(i.userRole),
    company: s(i.userCompany),
    industry: s(i.userIndustry),
    location: s(i.userCity) || s(i.userLocation),
    about: s(i.userProfileSummary),
    wantsToMeet: [...a(i.desiredPeople), ...a(i.desiredRoles)].slice(0, 6),
    offers: a(i.userCanOffer).slice(0, 6),
  };
}
