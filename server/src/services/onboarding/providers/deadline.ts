// ─── One deadline for a whole lookup (provider calls + gap fill) ─────────────
//
// 18 Sep 2026 (Shradha): nothing above the provider bounded the wait. 12 Nov 2026: the same bound now covers the
// approval-time lookup and its retry too (a hung Anthropic call in the gap fill uses the SDK's 10-minute default),
// and the answer that arrives after the deadline is handed back instead of being thrown away: it may be a profile
// ScrapingDog already billed.

import logger from '../../../config/logger';
import type { ProviderOutcome } from './provider.types';

/** The whole lookup. ScrapingDog's one call takes at most SCRAPE_TOTAL_MS (100 s, scrapingdog.provider.ts),
 *  which leaves 50 s of this for the gap fill. */
export const PROVIDER_DEADLINE_MS = 150 * 1000;

/** The reason a lookup cut at the deadline reports: its persisted error text starts with this. */
export const DEADLINE_REASON = `provider deadline of ${Math.round(PROVIDER_DEADLINE_MS / 1000)}s reached`;

export interface RacedOutcome {
  outcome: ProviderOutcome;
  /** Set only when the deadline won: the lookup still running, for the caller to keep what it brings. */
  late: Promise<ProviderOutcome> | null;
}

/** Race a lookup against the deadline. Never rejects: a lookup that throws reads as provider_error. */
export function raceProviderDeadline(
  run: Promise<ProviderOutcome>,
  context: Record<string, string | null>,
  deadlineMs: number = PROVIDER_DEADLINE_MS,
): Promise<RacedOutcome> {
  const safe = run.catch((err: unknown): ProviderOutcome => ({
    kind: 'provider_error',
    reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RacedOutcome>((resolve) => {
    timer = setTimeout(() => {
      logger.warn({ ...context, deadlineMs }, 'enrichment: provider deadline reached');
      resolve({ outcome: { kind: 'provider_error', reason: DEADLINE_REASON }, late: safe });
    }, deadlineMs);
  });
  const inTime = safe.then((outcome): RacedOutcome => ({ outcome, late: null }));
  return Promise.race([inTime, deadline]).finally(() => clearTimeout(timer));
}
