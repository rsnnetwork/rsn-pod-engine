// ─── The ids in /api/dm paths (26 Oct 2026) ──────────────────────────────────
//
// routes/dm.ts and routes/meeting.ts share the /api/dm mount, and every id in its paths is checked here
// before it reaches the database. An id that is not a uuid (the word "undefined", say) failed Postgres's
// cast and came back a 500; now it is a 400 VALIDATION_ERROR whose message and first detail are a sentence a
// member reads (production's client shows the message, the preview the first detail). A well-formed id in
// capitals names the same row, and is lower-cased, so the tags a service sends for it match the ones each
// screen listens for. Each check reads one part of the path and passes the others through untouched.

import { z } from 'zod';
import { validate } from './validate';

/** What each refusal says. */
export const DM_PATH_REFUSALS = {
  conversation: "We couldn't find that conversation.",
  callRequest: "We couldn't find that call request.",
  message: "We couldn't find that message.",
  member: "We couldn't find that member.",
  reaction: "That reaction isn't available.",
} as const;

/** Check one part of the path, refusing with `sentence`; the path's other parts are kept as they are. */
function checkPathPart(name: string, part: z.ZodTypeAny, sentence: string) {
  return validate(z.object({ [name]: part }).passthrough(), 'params', sentence);
}

/** A uuid, lower-cased. */
const uuid = (sentence: string) => z.string().uuid(sentence).transform((s) => s.toLowerCase());

export const conversationIdInPath = checkPathPart('id', uuid(DM_PATH_REFUSALS.conversation), DM_PATH_REFUSALS.conversation);
export const callRequestIdInPath = checkPathPart('id', uuid(DM_PATH_REFUSALS.callRequest), DM_PATH_REFUSALS.callRequest);
export const messageIdInPath = checkPathPart('id', uuid(DM_PATH_REFUSALS.message), DM_PATH_REFUSALS.message);
export const memberIdInPath = checkPathPart('userId', uuid(DM_PATH_REFUSALS.member), DM_PATH_REFUSALS.member);

/** The service checks a reaction against its list; this refuses only one too long to be on it, as the body's check does. */
export const reactionInPath = checkPathPart(
  'emoji',
  z.string().min(1, DM_PATH_REFUSALS.reaction).max(16, DM_PATH_REFUSALS.reaction),
  DM_PATH_REFUSALS.reaction,
);
