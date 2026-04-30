// ─── Notification Preferences Service ────────────────────────────────────────
//
// Phase J of chat-fix-and-dm-system plan (1 May 2026). Stefan: "the
// possibility should be there, and be changed in your settings". Per-user
// toggles for bell + email per notification category.

import { query } from '../../db';
import logger from '../../config/logger';

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
}

export const DEFAULT_PREFS: NotificationPrefs = {
  dm_bell: true,
  dm_email: true,
  poke_bell: true,
  poke_email: false,
  group_bell: true,
  group_email: false,
  invite_bell: true,
  invite_email: true,
  report_resolved_bell: true,
  report_resolved_email: false,
};

export async function getPrefs(userId: string): Promise<NotificationPrefs> {
  const result = await query<{ notification_prefs: NotificationPrefs | null }>(
    `SELECT notification_prefs FROM users WHERE id = $1`,
    [userId],
  );
  if (result.rows.length === 0 || !result.rows[0].notification_prefs) {
    return DEFAULT_PREFS;
  }
  return { ...DEFAULT_PREFS, ...result.rows[0].notification_prefs };
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
  const next: NotificationPrefs = { ...current };
  for (const key of Object.keys(DEFAULT_PREFS) as (keyof NotificationPrefs)[]) {
    if (key in patch && typeof patch[key] === 'boolean') {
      next[key] = patch[key]!;
    }
  }
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
  const key = `${category}_email` as keyof NotificationPrefs;
  return prefs[key];
}

export async function shouldSendBell(
  userId: string,
  category: 'dm' | 'poke' | 'group' | 'invite' | 'report_resolved',
): Promise<boolean> {
  const prefs = await getPrefs(userId);
  const key = `${category}_bell` as keyof NotificationPrefs;
  return prefs[key];
}
