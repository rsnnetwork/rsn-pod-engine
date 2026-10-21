// ─── Onboarding v2, screen 2: "Continue with LinkedIn" ───────────────────────
//
// Ali, 21 Oct 2026: the member's own LinkedIn profile link goes through the
// existing ScrapingDog lookup, which fills in role, company and industry. The
// member corrects anything before it is saved (screen 7), and no LinkedIn app
// is involved. This replaces the 23 Sep "photo only" rule for v2.
//
// The lookup costs money, so asking twice never pays twice. A lookup only
// starts when nothing is running and no result exists for that address. The
// enrichment state does not record which address it ran for; lookups always
// run for the address on the member's row, so "for that address" is read as
// "the address on the row before this request was the same one".
//
// The address is normalised here with the same rules Task 2 uses for join
// requests (that code lives in the join-request route; the two are kept apart
// for now and should share one helper later).

import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { NotFoundError, ValidationError } from '../../middleware/errors';
import { linkedinSlug, type EnrichResult } from './enrichment.service';
import {
  getCachedEnrichment, getEnrichmentState, saveEnrichedCandidate, setEnrichmentState,
  type EnrichmentDbState,
} from './enrichment.repo';
import { runEnrichment, isFreshCacheHit, SEARCHING_LOCK_MS } from './enrichment.orchestrator';
import { statusFromResult } from './providers/registry';
import { selfGuessFromRole } from '../matching/option-signals';
import { fanoutUserEntity } from '../../realtime/fanout';
import type { OnboardingV2Linkedin, OnboardingV2LinkedinPrefill } from '@rsn/shared';

export const LINKEDIN_URL_MESSAGE = 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Not found" is an answer about that address; it stands as long as a found result would. */
const NOT_FOUND_STANDS_MS = 90 * DAY_MS;
/** A failure (timeout, provider error) is not an answer. Retried, but never straight away. */
const FAILED_RETRY_AFTER_MS = 10 * 60 * 1000;

const SLUG_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{1,99}$/u;
const isLinkedinHost = (host: string) => host === 'linkedin.com' || host.endsWith('.linkedin.com');

/**
 * Any linkedin.com/in/<slug> form, with or without a protocol, www, a country
 * subdomain, a trailing slash, a query, a fragment or a sub-page, becomes
 * https://www.linkedin.com/in/<slug>. Anything else is null: another site, a
 * company page, a bare name, a script.
 */
export function normaliseLinkedinProfileUrl(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw || raw.length > 500 || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  if (!isLinkedinHost(url.hostname.toLowerCase())) return null;
  const path = url.pathname.match(/^\/in\/([^/]+)\/?/i);
  if (!path) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(path[1]).toLowerCase();
  } catch {
    return null;
  }
  return SLUG_SHAPE.test(slug) ? `https://www.linkedin.com/in/${slug}` : null;
}

export type LookupDecision =
  /** Nothing usable and nothing running: start a lookup. */
  | 'start'
  /** A lookup for another address is running: this one starts when it ends. */
  | 'queue'
  /** A lookup for this address is running: wait for it. */
  | 'running'
  /** A result for this address exists: use it. */
  | 'reuse'
  /** This address was looked up recently and that is the answer. */
  | 'done';

type StateTimes = Pick<EnrichmentDbState, 'status' | 'startedAt' | 'completedAt'>;

const runningNow = (s: StateTimes, now: number) =>
  s.status === 'searching' && !!s.startedAt && now - Date.parse(s.startedAt) < SEARCHING_LOCK_MS;

export function planLinkedinLookup(input: {
  requestedSlug: string;
  /** The slug of the address on the member's row before this request. */
  previousSlug: string | null;
  state: StateTimes;
  /** A fresh result for the requested address exists (their own, or the approval-time one). */
  usable: boolean;
  now: number;
}): LookupDecision {
  const sameAddress = input.previousSlug === input.requestedSlug;
  if (runningNow(input.state, input.now)) return sameAddress ? 'running' : 'queue';
  if (input.usable) return 'reuse';
  if (sameAddress && input.state.completedAt) {
    const age = input.now - Date.parse(input.state.completedAt);
    if (input.state.status === 'not_found' && age < NOT_FOUND_STANDS_MS) return 'done';
    if (input.state.status === 'failed' && age < FAILED_RETRY_AFTER_MS) return 'done';
  }
  return 'start';
}

type Preload = EnrichResult & { provider?: string | null };

/** A fresh result for this address: the member's own first, then the one made when they were approved. */
function usableResult(url: string, ownCache: EnrichResult | null, preload: Preload | null):
  { result: EnrichResult; preload: Preload | null } | null {
  if (ownCache && isFreshCacheHit(ownCache, url)) return { result: ownCache, preload: null };
  if (preload && isFreshCacheHit(preload, url)) return { result: preload, preload };
  return null;
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t.length ? t : null;
};

export function prefillFrom(result: EnrichResult): OnboardingV2LinkedinPrefill {
  const p = result.profile;
  const role = text(p?.currentRole);
  return {
    displayName: text(p?.fullName),
    photoUrl: text(p?.photoUrl),
    jobTitle: role,
    company: text(p?.currentCompany),
    industry: text(p?.industry),
    location: text(p?.location),
    // The role first; the headline is their own words too, when the page hid the role.
    selfGuess: selfGuessFromRole(role) ?? selfGuessFromRole(text(p?.headline)),
  };
}

function blockFrom(result: EnrichResult): OnboardingV2Linkedin {
  const status = statusFromResult(result);
  return status === 'not_found' ? { status } : { status, prefill: prefillFrom(result) };
}

export interface LinkedinSources {
  /** users.linkedin_url */
  currentUrl: string | null;
  state: StateTimes;
  ownCache: EnrichResult | null;
  preload: Preload | null;
  now: number;
}

/** The linkedin block of the onboarding state. A prefill only ever comes from a result for the current address. */
export function linkedinBlock(s: LinkedinSources): OnboardingV2Linkedin {
  if (!s.currentUrl) return { status: 'none' };
  if (runningNow(s.state, s.now)) return { status: 'searching' };
  const usable = usableResult(s.currentUrl, s.ownCache, s.preload);
  if (usable) return blockFrom(usable.result);
  // A lookup that never reached an end (the server restarted under it) failed.
  if (s.state.status === 'searching') return { status: 'failed' };
  if (s.state.status === 'not_found' || s.state.status === 'failed') return { status: s.state.status };
  return { status: 'none' };
}

/** The lookup made when the member was approved, read by email, as the photo and first sign-in do. */
async function approvalPreload(userId: string): Promise<Preload | null> {
  const r = await query<{ enriched: Preload | null }>(
    `SELECT jr.enriched
       FROM join_requests jr
       JOIN users u ON lower(u.email) = lower(jr.email)
      WHERE u.id = $1
        AND jr.status = 'approved'
        AND COALESCE((jr.enriched->>'confidence')::numeric, 0) > 0
      ORDER BY jr.reviewed_at DESC NULLS LAST
      LIMIT 1`,
    [userId],
  );
  return asResult(r.rows[0]?.enriched);
}

export function asResult<T extends EnrichResult>(v: unknown): T | null {
  return v && typeof v === 'object' && typeof (v as { confidence?: unknown }).confidence === 'number' ? (v as T) : null;
}

/** Copy the approval-time result onto the member, exactly as first sign-in does when it has landed. */
async function adoptPreload(userId: string, preload: Preload): Promise<void> {
  await saveEnrichedCandidate(userId, preload);
  await setEnrichmentState(userId, {
    status: statusFromResult(preload),
    source: preload.provider ?? null,
    startedAt: preload.enrichedAt,
    completedAt: preload.enrichedAt,
  });
}

/** The address on the member's profile now, and their name, for a lookup that waited its turn. */
async function currentAddress(userId: string): Promise<{ linkedin_url: string | null; display_name: string | null } | null> {
  const r = await query<{ linkedin_url: string | null; display_name: string | null }>(
    `SELECT linkedin_url, display_name FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Fire-and-forget: runEnrichment never throws and writes every state itself. */
function startLookup(userId: string, linkedinUrl: string, fullName: string | null, afterTheRunningOne: boolean): void {
  const run = (url: string, name: string | null) => runEnrichment(userId, { linkedinUrl: url, fullName: name || undefined });
  // runEnrichment hands back the lookup already running for this member, so
  // the call after it is the one that actually looks an address up. By then
  // the member may have changed the address again: look up the one their
  // profile holds at that moment, so a run of changes ends on the last one.
  const job = afterTheRunningOne
    ? run(linkedinUrl, fullName)
      .then(() => currentAddress(userId))
      .then(now => (now?.linkedin_url ? run(now.linkedin_url, now.display_name) : undefined))
    : run(linkedinUrl, fullName);
  job
    // The screens learn the outcome from the member's own entity tag.
    .then(() => fanoutUserEntity(userId))
    .catch(err => logger.error({ err, userId }, 'onboarding v2: the LinkedIn lookup rejected unexpectedly'));
}

export interface ConnectResult {
  linkedin: OnboardingV2Linkedin;
  /** The address as it was saved. */
  linkedinUrl: string;
  decision: LookupDecision;
}

/**
 * Save the member's LinkedIn address and look it up, unless a lookup for it is
 * running or already done. Returns the linkedin block as it stands now.
 */
export async function connectLinkedin(userId: string, rawUrl: string): Promise<ConnectResult> {
  const linkedinUrl = normaliseLinkedinProfileUrl(rawUrl);
  if (!linkedinUrl) throw new ValidationError(LINKEDIN_URL_MESSAGE, { url: [LINKEDIN_URL_MESSAGE] });

  // The row lock makes a double press read the address the first press saved.
  const before = await transaction(async (client) => {
    const cur = await client.query<{ linkedin_url: string | null; display_name: string | null }>(
      `SELECT linkedin_url, display_name FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const row = cur.rows[0];
    if (!row) throw new NotFoundError('User', userId);
    await client.query(`UPDATE users SET linkedin_url = $2, updated_at = NOW() WHERE id = $1`, [userId, linkedinUrl]);
    return row;
  });

  const [state, ownCache, preload] = await Promise.all([
    getEnrichmentState(userId),
    getCachedEnrichment(userId).catch(() => null),
    approvalPreload(userId).catch(() => null),
  ]);
  const usable = usableResult(linkedinUrl, ownCache, preload);
  const decision = planLinkedinLookup({
    requestedSlug: linkedinSlug(linkedinUrl)!,
    previousSlug: linkedinSlug(before.linkedin_url),
    state,
    usable: !!usable,
    now: Date.now(),
  });

  if (decision === 'reuse' && usable) {
    if (usable.preload) await adoptPreload(userId, usable.preload);
    return { linkedin: blockFrom(usable.result), linkedinUrl, decision };
  }
  if (decision === 'done') {
    return { linkedin: { status: state.status as 'not_found' | 'failed' }, linkedinUrl, decision };
  }
  if (decision === 'start' || decision === 'queue') {
    startLookup(userId, linkedinUrl, before.display_name, decision === 'queue');
  }
  return { linkedin: { status: 'searching' }, linkedinUrl, decision };
}
