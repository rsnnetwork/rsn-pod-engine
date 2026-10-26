// ─── The ids in /api/dm paths (26 Oct 2026) ──────────────────────────────────
//
// routes/dm.ts and routes/meeting.ts share the /api/dm mount, and every id in its paths is checked here
// before it reaches the database. An id that is not a uuid (the word "undefined", say) failed Postgres's
// cast and came back a 500; now it is a 400 VALIDATION_ERROR whose message and first detail are a sentence a
// member reads (production's client shows the message, the preview the first detail). A well-formed id in
// capitals names the same row, and is lower-cased, so the tags a service sends for it match the ones each
// screen listens for. Each check reads one part of the path and passes the others through untouched.
// The checks themselves are path-ids.ts's, which the routes outside /api/dm use too.

import { z } from 'zod';
import { PATH_REFUSALS, checkPathPart, uuidInPath } from './path-ids';

/** What each refusal says. */
export const DM_PATH_REFUSALS = {
  conversation: "We couldn't find that conversation.",
  callRequest: "We couldn't find that call request.",
  message: "We couldn't find that message.",
  member: PATH_REFUSALS.member,
  reaction: "That reaction isn't available.",
} as const;

export const conversationIdInPath = uuidInPath('id', DM_PATH_REFUSALS.conversation);
export const callRequestIdInPath = uuidInPath('id', DM_PATH_REFUSALS.callRequest);
export const messageIdInPath = uuidInPath('id', DM_PATH_REFUSALS.message);
export const memberIdInPath = uuidInPath('userId', DM_PATH_REFUSALS.member);

/** The service checks a reaction against its list; this refuses only one too long to be on it, as the body's check does. */
export const reactionInPath = checkPathPart(
  'emoji',
  z.string().min(1, DM_PATH_REFUSALS.reaction).max(16, DM_PATH_REFUSALS.reaction),
  DM_PATH_REFUSALS.reaction,
);
