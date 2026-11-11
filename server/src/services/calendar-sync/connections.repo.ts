// ─── calendar_connections, the table (migration 153; Shirley pilot S8, D7) ─────────────────────────────────────────────
// One row per member per provider. Tokens are sealed (secret-box.ts) before they get here and opened after they leave;
// no read below returns them to a route: listForMember is the only read a route answers with.

import type { CalendarConnection, CalendarProvider } from '@rsn/shared';
import { query } from '../../db';

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: CalendarProvider;
  account_email: string | null;
  refresh_token_enc: Buffer;
  access_token_enc: Buffer | null;
  access_expires_at: Date | null;
  status: 'active' | 'needs_reconnect';
  connected_at: Date;
}

const ROW = `id, user_id, provider, account_email, refresh_token_enc, access_token_enc, access_expires_at, status, connected_at`;

/** The member's connections with their sealed tokens, for the busy read and the close. Never sent to a client. */
export async function sealedRowsOf(userId: string): Promise<ConnectionRow[]> {
  const r = await query<ConnectionRow>(
    `SELECT ${ROW} FROM calendar_connections WHERE user_id = $1 ORDER BY provider`, [userId]);
  return r.rows;
}

export async function sealedRow(userId: string, provider: CalendarProvider): Promise<ConnectionRow | null> {
  const r = await query<ConnectionRow>(
    `SELECT ${ROW} FROM calendar_connections WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  return r.rows[0] ?? null;
}

/** What the member's Settings shows: provider, account, status, when. Never a token. */
export async function listForMember(userId: string): Promise<CalendarConnection[]> {
  const r = await query<{ provider: CalendarProvider; account_email: string | null; status: CalendarConnection['status']; connected_at: Date }>(
    `SELECT provider, account_email, status, connected_at FROM calendar_connections WHERE user_id = $1 ORDER BY provider`,
    [userId],
  );
  return r.rows.map((row) => ({
    provider: row.provider,
    accountEmail: row.account_email,
    status: row.status,
    connectedAt: new Date(row.connected_at).toISOString(),
  }));
}

export interface SealedGrant {
  accountEmail: string | null;
  scopes: string[];
  refreshTokenEnc: Buffer;
  accessTokenEnc: Buffer;
  accessExpiresAt: Date;
}

/** Connect, or connect again: one row per member and provider, made active with the new grant. */
export async function upsertConnection(userId: string, provider: CalendarProvider, g: SealedGrant): Promise<CalendarConnection> {
  const r = await query<{ provider: CalendarProvider; account_email: string | null; status: CalendarConnection['status']; connected_at: Date }>(
    `INSERT INTO calendar_connections
       (user_id, provider, account_email, scopes, refresh_token_enc, access_token_enc, access_expires_at, key_version, status,
        last_error, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'active', NULL, NOW(), NOW())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       account_email = EXCLUDED.account_email, scopes = EXCLUDED.scopes,
       refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, key_version = 1, status = 'active', last_error = NULL,
       connected_at = NOW(), updated_at = NOW()
     RETURNING provider, account_email, status, connected_at`,
    [userId, provider, g.accountEmail, g.scopes, g.refreshTokenEnc, g.accessTokenEnc, g.accessExpiresAt],
  );
  const row = r.rows[0];
  return { provider: row.provider, accountEmail: row.account_email, status: row.status, connectedAt: new Date(row.connected_at).toISOString() };
}

/**
 * A refresh's result: the new access token and, sealed again with a fresh IV, the refresh token (Microsoft's new one,
 * or Google's same one). Only while the row still holds the refresh token that was used (`usedRefreshEnc`): a
 * disconnect, a new connect or another refresh in between wins, and this one is dropped (its access token still serves
 * the read in hand).
 */
export async function saveRefresh(id: string, usedRefreshEnc: Buffer, refreshTokenEnc: Buffer, accessTokenEnc: Buffer, accessExpiresAt: Date): Promise<void> {
  await query(
    `UPDATE calendar_connections
        SET refresh_token_enc = $3, access_token_enc = $4, access_expires_at = $5, last_error = NULL, last_used_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND refresh_token_enc = $2 AND status = 'active'`,
    [id, usedRefreshEnc, refreshTokenEnc, accessTokenEnc, accessExpiresAt],
  );
}

export async function touchUsed(id: string): Promise<void> {
  await query(`UPDATE calendar_connections SET last_used_at = NOW() WHERE id = $1`, [id]);
}

/** The provider refused the grant (or the key cannot open it): the member must connect again. True when it changed. */
export async function markNeedsReconnect(id: string, code: string): Promise<boolean> {
  const r = await query(
    `UPDATE calendar_connections
        SET status = 'needs_reconnect', last_error = $2, access_token_enc = NULL, access_expires_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [id, code.slice(0, 40)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Disconnect: the row and its sealed tokens are gone. True when there was one. */
export async function deleteConnection(userId: string, provider: CalendarProvider): Promise<boolean> {
  const r = await query(`DELETE FROM calendar_connections WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteAllOf(userId: string): Promise<number> {
  const r = await query(`DELETE FROM calendar_connections WHERE user_id = $1`, [userId]);
  return r.rowCount ?? 0;
}
