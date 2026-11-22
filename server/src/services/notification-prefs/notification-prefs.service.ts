// ─── Notification Preferences Service ────────────────────────────────────────
//
// Phase J of chat-fix-and-dm-system plan (1 May 2026). Stefan: "the
// possibility should be there, and be changed in your settings". Per-user
// toggles for bell + email per notification category.
//
// 22 Nov 2026 (Stefan: "only get notifications if I am not online", "max X notifications a day", "a weekly digest"):
// three email settings beside the switches. email_away_only (on: a notification email waits ten minutes and goes only
// if the member has not been on REASON since; off: it goes at once), email_max_per_day (1, 3, 5 or 10: more than that
// waits for the next morning's "Yesterday on REASON") and weekly_digest ("Your week on REASON" on Monday mornings).
// The JSONB column keeps whatever an older row has; every read fills a missing or malformed key with its default.

import { query } from '../../db';
import logger from '../../config/logger';

/** The choices "Most emails a day" offers. */
export const EMAIL_MAX_PER_DAY_CHOICES = [1, 3, 5, 10] as const;
export type EmailMaxPerDay = (typeof EMAIL_MAX_PER_DAY_CHOICES)[number];

export interface NotificationPrefs {
  dm_bell: boolean;
  dm_email: boolean;
  poke_bell: boolean;
  poke_email: boolean;
  group_bell: boolean;
  group_email: boolean;
  invite_bell: boolean;
  invite_email: boolean;
  report_resolved_bell: boolean;
  report_resolved_email: boolean;
  /** Only email a notification when the member has not been on REASON since it happened. */
  email_away_only: boolean;
  /** The most notification emails a day; the rest wait for the next morning's email. */
  email_max_per_day: EmailMaxPerDay;
  /** "Your week on REASON", Monday mornings. */
  weekly_digest: boolean;
}

type BooleanPrefKey = { [K in keyof NotificationPrefs]: NotificationPrefs[K] extends boolean ? K : never }[keyof NotificationPrefs];

// pokes-notification-prefs (23 Jul 2026) — poke_email flipped false → true.
// The stored false (053) was an invisible seeded default for a toggle that
// had no enforcement behind it; nobody consciously opted out of anything
// real. Migration 084 flips the column DEFAULT + backfills existing rows to
// match — this constant is the in-process fallback for the same shape, used
// when a row's notification_prefs is missing a key entirely.
export const DEFAULT_PREFS: NotificationPrefs = {
  dm_bell: true,
  dm_email: true,
  poke_bell: true,
  poke_email: true,
  group_bell: true,
  group_email: false,
  invite_bell: true,
  invite_email: true,
  report_resolved_bell: true,
  report_resolved_email: false,
  email_away_only: true,
  email_max_per_day: 3,
  weekly_digest: true,
};

const BOOLEAN_KEYS = (Object.keys(DEFAULT_PREFS) as (keyof NotificationPrefs)[])
  .filter((key): key is BooleanPrefKey => typeof DEFAULT_PREFS[key] === 'boolean');

const isMaxPerDay = (value: unknown): value is EmailMaxPerDay =>
  (EMAIL_MAX_PER_DAY_CHOICES as readonly unknown[]).includes(value);

/**
 * A stored notification_prefs value read as a whole set of preferences: every key the member set to a value of the
 * right kind keeps it, everything else (missing, unknown, the wrong type, a daily maximum not offered) is the default.
 */
export function prefsFromStored(stored: unknown): NotificationPrefs {
  const out: NotificationPrefs = { ...DEFAULT_PREFS };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  const row = stored as Record<string, unknown>;
  for (const key of BOOLEAN_KEYS) {
    if (typeof row[key] === 'boolean') out[key] = row[key] as boolean;
  }
  if (isMaxPerDay(row.email_max_per_day)) out.email_max_per_day = row.email_max_per_day;
  return out;
}

export async function getPrefs(userId: string): Promise<NotificationPrefs> {
  const result = await query<{ notification_prefs: unknown }>(
    `SELECT notification_prefs FROM users WHERE id = $1`,
    [userId],
  );
  return prefsFromStored(result.rows[0]?.notification_prefs ?? null);
}

/** The preferences with a partial applied: a key of the wrong type, or a daily maximum not offered, is left as it was. */
export function applyPrefsPatch(current: NotificationPrefs, patch: Partial<Record<keyof NotificationPrefs, unknown>>): NotificationPrefs {
  const next: NotificationPrefs = { ...current };
  for (const key of BOOLEAN_KEYS) {
    if (key in patch && typeof patch[key] === 'boolean') next[key] = patch[key] as boolean;
  }
  if (isMaxPerDay(patch.email_max_per_day)) next.email_max_per_day = patch.email_max_per_day;
  return next;
}

/**
 * Update preferences. Accepts a partial — unspecified keys keep their
 * current value. Unknown keys are ignored.
 */
export async function updatePrefs(
  userId: string,
  patch: Partial<NotificationPrefs>,
): Promise<NotificationPrefs> {
  const current = await getPrefs(userId);
  const next = applyPrefsPatch(current, patch);
  await query(
    `UPDATE users SET notification_prefs = $1 WHERE id = $2`,
    [JSON.stringify(next), userId],
  );
  logger.info({ userId, patch }, 'Notification prefs updated');
  return next;
}

/**
 * Quick read: should we send an email of this kind to this user?
 * Returns true on missing prefs (default = on for invite/dm).
 */
export async function shouldSendEmail(
  userId: string,
  category: 'dm' | 'poke' | 'group' | 'invite' | 'report_resolved',
): Promise<boolean> {
  const prefs = await getPrefs(userId);
  const key = `${category}_email` as BooleanPrefKey;
  return prefs[key];
}

export async function shouldSendBell(
  userId: string,
  category: 'dm' | 'poke' | 'group' | 'invite' | 'report_resolved',
): Promise<boolean> {
  const prefs = await getPrefs(userId);
  const key = `${category}_bell` as BooleanPrefKey;
  return prefs[key];
}
