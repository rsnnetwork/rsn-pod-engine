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
  type HostKnownExtra,
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
    return out;
  }
  const questions = (body.match(/\?/g) || []).length;
  if (questions === 0) out.push('it asks no question');
  if (questions > 1) out.push('it asks more than one question');
  if (wordCount > 28) out.push('it is over 25 words');
  const question = body.split(/(?<=[.!])\s+/).find((s) => s.includes('?')) || '';
  if (/\bor\b/i.test(question)) out.push('the question offers alternatives joined by "or"');
  const afterReaction = body.replace(/^\s*[^.!?]{0,24}[.!]\s*/, '');
  if (/^\s*(so you|you're |you are |you want |sounds like|it sounds like)/i.test(afterReaction)) {
    out.push('it reads their answer back to them');
  }
  return out;
}

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
  const ready = text.includes(READY_TOKEN);
  if (ready) text = text.replace(READY_TOKEN, '').trim();
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
  wrapMode: 'none' | 'soft' | 'hard' | 'opening' = 'none',
  extra?: HostKnownExtra,
  effectiveOpening?: OnboardingOpening
): Promise<{ reply: string; ready: boolean }> {
  const system = buildHostSystemPrompt(profile, wrapMode, extra, effectiveOpening);
  const first = await askHost(system, messages);
  const broken = styleViolations(first.reply, first.ready);
  if (broken.length === 0) return first;

  // One corrective rewrite. If that is no better, the first draft still goes
  // out: a slightly long message beats a stalled chat.
  logger.warn({ broken, draft: first.reply.slice(0, 160) }, 'onboarding host: draft broke the style rules, asking for a rewrite');
  try {
    const rewriteSystem = system +
      '\n\nREWRITE. Your previous draft was:\n"' + first.reply.replace(/"/g, "'") + '"\nIt broke these rules: ' + broken.join('; ') +
      '. Write the message again so it follows every style rule: no reading their answer back, at most three words of reaction, exactly one question of at most 15 words with no "or" in it, under 25 words in total' +
      (first.ready ? ', and keep the ready token' : '') + '. Reply with the message only.';
    const second = await askHost(rewriteSystem, messages);
    const stillBroken = styleViolations(second.reply, second.ready);
    if (stillBroken.length < broken.length) return second;
    logger.warn({ stillBroken }, 'onboarding host: rewrite was no better, sending the first draft');
  } catch (err) {
    logger.warn({ err }, 'onboarding host: rewrite call failed, sending the first draft');
  }
  return first;
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
  messages: OnboardingMessage[]
): Promise<ExtractedIntent> {
  const anthropic = getClient();
  const resp = await anthropic.messages.create({
    model: config.onboardingExtractModel,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: EXTRACTION_PROMPT + serializeConversation(messages) + EXTRACTION_OUTPUT_CONTRACT,
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
