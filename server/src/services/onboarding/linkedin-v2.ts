// ─── Onboarding v2, screen 2: "Continue with LinkedIn" ───────────────────────
//
// Ali, 21 Oct 2026: the member's own LinkedIn profile link goes through the
// existing ScrapingDog lookup, which fills in role, company and industry. The
// member corrects anything before it is saved (screen 7), and no LinkedIn app
// is involved. This replaces the 23 Sep "photo only" rule for v2.
//
// The lookup costs money, so asking twice never pays twice. A lookup only
// starts when nothing is running and no result exists for that address.
//
// Fix round 1 (21 Oct 2026): "for that address" is the address the lookup
// RECORDED it ran for (inferred_profile.lastLookup, written with every state
// by enrichment.repo setEnrichmentState), never the address on the member's
// row, which their own profile edit writes without any lookup.
//
// The address is read by the one helper the request to join uses too
// (linkedinProfileUrl in @rsn/shared, since the final review of 21 Oct), so a
// profile is stored the same way whichever form it came through.

import { query } from '../../db';
import logger from '../../config/logger';
import { NotFoundError, ValidationError } from '../../middleware/errors';
import { linkedinSlug, type EnrichResult } from './enrichment.service';
import { saveEnrichedCandidate, setEnrichmentState, type EnrichmentStatus } from './enrichment.repo';
import { runEnrichment, isFreshCacheHit, SEARCHING_LOCK_MS } from './enrichment.orchestrator';
import { statusFromResult } from './providers/registry';
import { selfGuessFromRole } from '../matching/option-signals';
import { fanoutUserEntity } from '../../realtime/fanout';
import { LINKEDIN_PROFILE_HELP, linkedinProfileUrl, type OnboardingV2Linkedin, type OnboardingV2LinkedinPrefill } from '@rsn/shared';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Not found" is an answer about that address; it stands as long as a found result would. */
const NOT_FOUND_STANDS_MS = 90 * DAY_MS;
/** A failure (timeout, provider error) is not an answer. Retried, but never straight away. */
const FAILED_RETRY_AFTER_MS = 10 * 60 * 1000;

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

/** The member's enrichment state, and the address the lookup it describes ran for. */
export interface LookupState {
  status: EnrichmentStatus;
  startedAt: string | null;
  completedAt: string | null;
  /** inferred_profile.lastLookup.linkedinUrl; null when not recorded or a lookup for no address. */
  lookupUrl: string | null;
}

type StateTimes = Pick<LookupState, 'status' | 'startedAt' | 'completedAt'>;

const runningNow = (s: StateTimes, now: number) =>
  s.status === 'searching' && !!s.startedAt && now - Date.parse(s.startedAt) < SEARCHING_LOCK_MS;

export function planLinkedinLookup(input: {
  requestedSlug: string;
  /** The slug of the address the state's lookup ran for, as recorded; null when not recorded. */
  lookupSlug: string | null;
  state: StateTimes;
  /** A fresh result for the requested address exists (their own, or the approval-time one). */
  usable: boolean;
  now: number;
}): LookupDecision {
  const sameAddress = input.lookupSlug !== null && input.lookupSlug === input.requestedSlug;
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
  state: LookupState;
  ownCache: EnrichResult | null;
  preload: Preload | null;
  now: number;
}

/**
 * The linkedin block of the onboarding state. A prefill only ever comes from a
 * result for the current address, and "not found" or "failed" only ever from
 * a lookup recorded as having been for it: an address the member changed on
 * their profile page, never looked up, is 'none'.
 */
export function linkedinBlock(s: LinkedinSources): OnboardingV2Linkedin {
  if (!s.currentUrl) return { status: 'none' };
  // A lookup is running. It may be the one before this address's own, which is queued behind it.
  if (runningNow(s.state, s.now)) return { status: 'searching' };
  const usable = usableResult(s.currentUrl, s.ownCache, s.preload);
  if (usable) return blockFrom(usable.result);
  const lookupSlug = linkedinSlug(s.state.lookupUrl);
  if (!lookupSlug || lookupSlug !== linkedinSlug(s.currentUrl)) return { status: 'none' };
  // A lookup that never reached an end (the server restarted under it) failed.
  if (s.state.status === 'searching') return { status: 'failed' };
  if (s.state.status === 'not_found' || s.state.status === 'failed') return { status: s.state.status };
  return { status: 'none' };
}

export function asResult<T extends EnrichResult>(v: unknown): T | null {
  return v && typeof v === 'object' && typeof (v as { confidence?: unknown }).confidence === 'number' ? (v as T) : null;
}

/** The columns a LinkedIn decision reads, as linkedinSources() and the onboarding state select them. */
export interface LinkedinRow {
  linkedin_url: string | null;
  enrichment_status: EnrichmentStatus | null;
  enrichment_started_at: Date | string | null;
  enrichment_completed_at: Date | string | null;
  /** inferred_profile->'lastLookup'->>'linkedinUrl' */
  lookup_url: string | null;
  /** inferred_profile->'enriched' */
  enriched: unknown;
  /** The approved join request's enriched blob. */
  preload: unknown;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

export function sourcesFromRow(row: LinkedinRow, now = Date.now()): LinkedinSources {
  return {
    currentUrl: row.linkedin_url,
    state: {
      status: row.enrichment_status ?? 'none',
      startedAt: iso(row.enrichment_started_at),
      completedAt: iso(row.enrichment_completed_at),
      lookupUrl: row.lookup_url,
    },
    ownCache: asResult<EnrichResult>(row.enriched),
    preload: asResult<Preload>(row.preload),
    now,
  };
}

/**
 * Everything a LinkedIn decision reads, in one query: the address on the
 * profile, the state and the address its lookup ran for, the member's own
 * result, and the lookup made when they were approved (read by email, as the
 * photo and first sign-in do).
 */
async function linkedinSources(userId: string): Promise<{ sources: LinkedinSources; displayName: string | null } | null> {
  const r = await query<LinkedinRow & { display_name: string | null }>(
    `SELECT u.linkedin_url, u.display_name,
            p.enrichment_status, p.enrichment_started_at, p.enrichment_completed_at,
            p.inferred_profile->'lastLookup'->>'linkedinUrl' AS lookup_url,
            p.inferred_profile->'enriched' AS enriched,
            jr.enriched AS preload
       FROM users u
       LEFT JOIN user_intent_profiles p ON p.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT j.enriched FROM join_requests j
          WHERE lower(j.email) = lower(u.email) AND j.status = 'approved'
          ORDER BY j.reviewed_at DESC NULLS LAST
          LIMIT 1
       ) jr ON TRUE
      WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  return row ? { sources: sourcesFromRow(row), displayName: row.display_name } : null;
}

/**
 * The prefill the onboarding state shows the member right now, or null. The
 * confirm takes the photo ("Keep this photo") and decides whether a title was
 * kept as LinkedIn had it from this, so neither can come from a result the
 * member was never shown.
 */
export async function shownPrefill(userId: string): Promise<OnboardingV2LinkedinPrefill | null> {
  const loaded = await linkedinSources(userId);
  return loaded ? linkedinBlock(loaded.sources).prefill ?? null : null;
}

/** Copy the approval-time result onto the member, as first sign-in does when it has landed, recorded as for its address. */
async function adoptPreload(userId: string, preload: Preload): Promise<void> {
  await saveEnrichedCandidate(userId, preload);
  await setEnrichmentState(userId, {
    status: statusFromResult(preload),
    source: preload.provider ?? null,
    startedAt: preload.enrichedAt,
    completedAt: preload.enrichedAt,
    linkedinUrl: preload.requestedLinkedinUrl,
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
  const linkedinUrl = linkedinProfileUrl(rawUrl);
  if (!linkedinUrl) throw new ValidationError(LINKEDIN_PROFILE_HELP, { url: [LINKEDIN_PROFILE_HELP] });

  const saved = await query<{ display_name: string | null }>(
    `UPDATE users SET linkedin_url = $2, updated_at = NOW() WHERE id = $1 RETURNING display_name`,
    [userId, linkedinUrl],
  );
  if (!saved.rows[0]) throw new NotFoundError('User', userId);
  const displayName = saved.rows[0].display_name;

  const loaded = await linkedinSources(userId);
  if (!loaded) throw new NotFoundError('User', userId);
  const { sources } = loaded;
  const usable = usableResult(linkedinUrl, sources.ownCache, sources.preload);
  const decision = planLinkedinLookup({
    requestedSlug: linkedinSlug(linkedinUrl)!,
    lookupSlug: linkedinSlug(sources.state.lookupUrl),
    state: sources.state,
    usable: !!usable,
    now: sources.now,
  });

  if (decision === 'reuse' && usable) {
    if (usable.preload) await adoptPreload(userId, usable.preload);
    return { linkedin: blockFrom(usable.result), linkedinUrl, decision };
  }
  if (decision === 'done') {
    return { linkedin: { status: sources.state.status as 'not_found' | 'failed' }, linkedinUrl, decision };
  }
  if (decision === 'start' || decision === 'queue') {
    // A double press runs this twice before the first lookup has written its
    // state: runEnrichment hands the second call the first one's lookup.
    startLookup(userId, linkedinUrl, displayName, decision === 'queue');
  }
  return { linkedin: { status: 'searching' }, linkedinUrl, decision };
}
