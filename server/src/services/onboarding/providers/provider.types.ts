// ─── Enrichment Provider Contract ────────────────────────────────────────────
//
// A provider fetches (or synthesizes) a member's profile from their LinkedIn
// URL and reports a typed outcome — never throws, never returns a bare
// EnrichResult. Callers branch on `kind` to decide fallback (e.g. retry with
// the claude_web provider on `provider_error`, or surface a friendly message
// on `not_found`).

import type { EnrichResult } from '../enrichment.service';

export type ProviderOutcome =
  | { kind: 'found'; result: EnrichResult; photoUrl: string | null }
  | { kind: 'partial'; result: EnrichResult; photoUrl: string | null; missing: string[] }
  | { kind: 'not_found'; reason: string } // 400/404/410 — profile genuinely unretrievable
  // 202s past the attempt budget; `rateLimited` when it was the plan's rate
  // limit that never cleared (a follow-up call would be limited too);
  // `notReady` when ScrapingDog said it is fetching the page now and to ask
  // again in two to three minutes (a later attempt is the only way to get it);
  // `timedOut` when the live call timed out or failed and the cached call had
  // too little time left to answer: the outcome is unknown, so a later attempt.
  | { kind: 'retry_exhausted'; rateLimited?: boolean; notReady?: boolean; timedOut?: boolean }
  | { kind: 'provider_error'; reason: string }; // network / 5xx / bad key

export interface EnrichmentProvider {
  readonly name: 'scrapingdog' | 'claude_web';
  enrich(input: { linkedinUrl: string; fullName?: string }): Promise<ProviderOutcome>;
}
