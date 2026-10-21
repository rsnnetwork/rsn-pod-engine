// ─── The LinkedIn photo, offered — never applied on the member's behalf ──────
//
// 23 Sep 2026. Shradha's deck: "never show the user a guess as fact. Everything
// in the profile comes from what they ticked or typed — and they confirm it."
// It came from Stefan's own test, where the LinkedIn match was the wrong person.
//
// Everything else LinkedIn used to fill (headline, role, company, about) is
// already gone from the card. The photo was the one thing still put on a
// profile automatically — at first sign-in, and from the enrichment
// orchestrator — and a scrape that lands on the wrong person would give
// someone a stranger's face. It is also where most member photos have come
// from (37 of 41 recorded, by 23 Sep), so it is kept, but only as an offer:
// the member sees it and says "that's me" before it is theirs.
//
// WHERE IT LIVES. Two places, and the second is the race fix. The approval
// preload scrapes into join_requests.enriched, and first sign-in copies that
// onto the account ONCE. Someone who signs in before the scrape finishes —
// Ali's own test, 23 Sep: signed in 23s after approval, scrape took 25s — got
// nothing copied, and nothing ever looked again. Reading both places at the
// moment the photo is needed works whichever finished first.

import { query } from '../../db';
import logger from '../../config/logger';
import { captureAvatar } from './avatar.service';
import { record as recordStageEvent } from './stage-events.repo';
import { shownPrefill } from './linkedin-v2';

/**
 * The member's own scraped LinkedIn photo, or null.
 *
 * Only ever resolved from what WE stored for THIS member — never from a URL a
 * client sends, so this cannot be turned into "fetch any image onto my
 * profile" or "put someone else's photo on me".
 */
export async function findLinkedinPhoto(userId: string): Promise<string | null> {
  const own = await query<{ url: string | null }>(
    `SELECT inferred_profile->'enriched'->'profile'->>'photoUrl' AS url
       FROM user_intent_profiles
      WHERE user_id = $1
        AND COALESCE((inferred_profile->'enriched'->>'confidence')::numeric, 0) > 0`,
    [userId],
  );
  if (own.rows[0]?.url) return own.rows[0].url;

  // The approval-time scrape, for a member who signed in before it landed.
  const preload = await query<{ url: string | null }>(
    `SELECT jr.enriched->'profile'->>'photoUrl' AS url
       FROM join_requests jr
       JOIN users u ON lower(u.email) = lower(jr.email)
      WHERE u.id = $1
        AND jr.status = 'approved'
        AND COALESCE((jr.enriched->>'confidence')::numeric, 0) > 0
      ORDER BY jr.reviewed_at DESC NULLS LAST
      LIMIT 1`,
    [userId],
  );
  return preload.rows[0]?.url ?? null;
}

export type UseLinkedinPhotoResult = 'done' | 'none' | 'failed';

/**
 * The member said "that's me". Capture the photo we found for them and make it
 * their avatar. 'none' when there is nothing to offer, 'failed' when the
 * download did not work — both leave their current photo exactly as it was.
 */
export async function useLinkedinPhoto(userId: string): Promise<UseLinkedinPhotoResult> {
  const url = await findLinkedinPhoto(userId);
  if (!url) return 'none';
  return capture(userId, url);
}

/**
 * Onboarding v2's "Keep this photo" (21 Oct 2026): the photo the member was
 * shown, which is the one in the onboarding state's LinkedIn prefill for the
 * address on their profile, and no other. findLinkedinPhoto above takes their
 * own cached photo for any address and any age, which may be one this screen
 * never showed them. Like useLinkedinPhoto, it takes no URL.
 */
export async function useShownLinkedinPhoto(userId: string): Promise<UseLinkedinPhotoResult> {
  const url = (await shownPrefill(userId))?.photoUrl ?? null;
  if (!url) return 'none';
  return capture(userId, url);
}

/** Make a photo WE resolved for the member theirs, recorded on the stage trail. */
async function capture(userId: string, url: string): Promise<'done' | 'failed'> {
  const startedAt = Date.now();
  const captured = await captureAvatar(userId, url);
  recordStageEvent(
    userId, captured ? 'photo_captured' : 'photo_failed',
    { source: 'linkedin_confirmed' }, Date.now() - startedAt,
  ).catch(() => {});
  if (!captured) logger.warn({ userId }, 'linkedin photo: the member confirmed it but the download failed');
  return captured ? 'done' : 'failed';
}
