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
import config from '../../config';
import { OnboardingMessage, OnboardingConfirmedProfile } from '@rsn/shared';
import { IntentSchema, INTENT_JSON_SCHEMA, ExtractedIntent } from './intent.schema';
import {
  buildHostSystemPrompt,
  EXTRACTION_PROMPT,
  READY_TOKEN,
  serializeConversation,
} from './prompts';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    client = new Anthropic({ apiKey: config.anthropicApiKey });
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
 */
export async function converse(
  messages: OnboardingMessage[],
  profile?: OnboardingConfirmedProfile,
  wrapMode: 'none' | 'soft' | 'hard' = 'none'
): Promise<{ reply: string; ready: boolean }> {
  const anthropic = getClient();
  const resp = await anthropic.messages.create({
    model: config.onboardingChatModel,
    max_tokens: 1024,
    system: buildHostSystemPrompt(profile, wrapMode),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  let text = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();

  const ready = text.includes(READY_TOKEN);
  if (ready) {
    text = text.replace(READY_TOKEN, '').trim();
  }

  return { reply: text, ready };
}

/**
 * Claude call #2 — structured extraction. We constrain the model with a raw
 * JSON Schema via `output_config.format`, then validate the reply against
 * IntentSchema (zod) so a malformed payload throws instead of corrupting the
 * profile. (We don't use the SDK's zodOutputFormat helper — it targets zod v4
 * and this project is pinned to zod v3.)
 */
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
        content: EXTRACTION_PROMPT + serializeConversation(messages),
      },
    ],
    output_config: { format: { type: 'json_schema', schema: INTENT_JSON_SCHEMA } },
  });

  const raw = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (!raw) {
    throw new Error('Onboarding extraction returned no content');
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('Onboarding extraction returned invalid JSON');
  }
  return IntentSchema.parse(json);
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
