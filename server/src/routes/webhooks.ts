// ─── LiveKit Webhook Receiver ──────────────────────────────────────────────────
// Receives signed webhook events from LiveKit Cloud and reconciles canonical
// connState in Redis. Inert until LiveKit Cloud is configured to POST to this URL.
//
// Activation (hand to Ali, not done here):
//   LiveKit Cloud → project settings → Webhooks → add:
//   https://api.rsn.network/api/webhooks/livekit  (content-type: application/webhook+json)
//
// Body-parser note: express.json() (global middleware in index.ts) only processes
// Content-Type: application/json — it ignores application/webhook+json, so the raw
// body is intact when the per-route raw() middleware runs below.

import { Router, raw } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { config } from '../config';
import logger from '../config/logger';
import { updateCanonicalParticipant } from '../services/orchestration/state/canonical-state';

const receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);

function sessionIdFromRoom(room: string): string | null {
  const m = room.match(/^lobby-(.+)$/) || room.match(/^match-(.+?)-r\d+-/);
  return m ? m[1] : null;
}

export const webhooksRouter = Router();

// LiveKit posts JSON with a signature in the Authorization header; we need the
// RAW body to verify. Mount with express.raw at the registrar.
webhooksRouter.post('/livekit', raw({ type: 'application/webhook+json' }), async (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body.toString() : String(req.body || '');
    const event = await receiver.receive(body, req.get('Authorization'));
    const room = event.room?.name;
    const identity = event.participant?.identity;
    // Observability — a verified webhook would otherwise be silent. info-level
    // so the success path is visible in Render logs (signature failures still
    // surface via the catch below).
    logger.info({ event: event.event, room, identity }, 'LiveKit webhook received');
    if (room && identity) {
      const sessionId = sessionIdFromRoom(room);
      if (sessionId) {
        if (event.event === 'participant_left') {
          await updateCanonicalParticipant(sessionId, identity, { connState: 'disconnected' });
        } else if (event.event === 'participant_joined') {
          await updateCanonicalParticipant(sessionId, identity, { connState: 'connected' });
        }
      }
    }
    res.status(200).end();
  } catch (err) {
    logger.warn({ err }, 'LiveKit webhook receive failed');
    res.status(200).end(); // ack anyway — never make LiveKit retry-storm
  }
});
