// server/src/services/orchestration/state/canonical-shadow.ts
// ─── Canonical Shadow Write ──────────────────────────────────────────────────
// Canonical-room-state Phase 1. Best-effort: read prev seq, project the live
// ActiveSession, write the canonical doc. Fired from persistSessionState. Never
// throws — it is purely additive and must not affect existing behavior.

import type { ActiveSession } from './session-state';
import { readCanonical, mergeProjectedCanonical } from './canonical-state';
import { projectActiveSessionToCanonical } from './canonical-projection';
import logger from '../../../config/logger';

export async function shadowWriteCanonical(activeSession: ActiveSession): Promise<void> {
  try {
    const prev = await readCanonical(activeSession.sessionId);
    const doc = projectActiveSessionToCanonical(activeSession, prev?.seq ?? 0);
    // 4 Jun ghost root cause — this used to writeCanonical (whole-doc
    // overwrite), resurrecting dead breakout locations from the stale
    // roomParticipants map after every room-end clear. Now a serialized
    // merge: existing canonical participants win, projection only adds.
    await mergeProjectedCanonical(doc);
  } catch (err) {
    logger.warn({ err, sessionId: activeSession.sessionId }, 'shadowWriteCanonical failed (non-fatal)');
  }
}
