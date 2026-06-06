// ─── Display Name Resolution ────────────────────────────────────────────────
//
// Phase 5 (1 May 2026 spec) — single source of truth for participant display
// names across server and client.
//
// Stefan's spec item 9: "Always show name + avatar + clear identity per user."
// Pre-Phase-5, the fallbackName helper was inlined 5 times across the server
// (matching-flow.ts ×3, participant-flow.ts ×2, host-actions.ts, chat-handlers.ts)
// with subtle variations. Display labels could disagree depending on which
// code path emitted the label.
//
// This module is the canonical helper. Server orchestration handlers and
// client-side renderers BOTH import from here.

/**
 * Resolve a display label for a user with sane fallbacks.
 *
 *   1. Trimmed display name if non-empty.
 *   2. Email prefix (everything before '@') if email is set.
 *   3. "Participant {first 6 chars of UUID}" — guarantees uniqueness when
 *      both display name and email are missing.
 *
 * Always returns a non-empty string. Never returns the bare user ID.
 */
export function resolveDisplayName(
  userId: string,
  displayName: string | null | undefined,
  email: string | null | undefined,
): string {
  const trimmed = (displayName || '').trim();
  if (trimmed) return trimmed;
  const emailPrefix = (email || '').split('@')[0]?.trim();
  if (emailPrefix) return emailPrefix;
  return `Participant ${userId.slice(0, 6)}`;
}

/**
 * Last-resort label when only the user ID is available (e.g. cache miss
 * inside a hot loop where no DB row was fetched). Same fallback shape as
 * resolveDisplayName so labels stay consistent.
 */
export function placeholderName(userId: string | null | undefined): string {
  // S25 (live-test bb) — a NULL fed from a 1-person room's empty B-slot
  // used to throw here (null.slice) and took the host-dashboard builder
  // down with it. A label helper must never be the thing that crashes a
  // pipeline — degrade to a generic label instead.
  return userId ? `Participant ${userId.slice(0, 6)}` : 'Participant';
}
