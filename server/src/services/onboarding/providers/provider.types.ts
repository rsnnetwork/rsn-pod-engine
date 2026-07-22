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
  | { kind: 'retry_exhausted' } // 202s past the deadline
  | { kind: 'provider_error'; reason: string }; // network / 5xx / bad key

export interface EnrichmentProvider {
  readonly name: 'scrapingdog' | 'claude_web';
  enrich(input: { linkedinUrl: string; fullName?: string }): Promise<ProviderOutcome>;
}
