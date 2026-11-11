// ─── The ids in a path (26 Oct 2026) ──────────────────────────────────────────
//
// An id that is not a uuid (the word "undefined", say) fails Postgres's cast and came back a 500. A route
// that checks its path first answers 400 VALIDATION_ERROR instead, whose message and first detail are a
// sentence a member reads (production's client shows the message, the preview the first detail), and the
// service is never reached. A well-formed id in capitals names the same row, and is lower-cased, so the tags
// a service sends for it match the ones each screen listens for. Each check reads one part of the path and
// passes the others through untouched. The /api/dm routes use these through dm-path-ids.ts.

import { z } from 'zod';
import { validate } from './validate';

/** What each refusal outside /api/dm says. */
export const PATH_REFUSALS = {
  member: "We couldn't find that member.",
  notification: "We couldn't find that notification.",
  agent: "We couldn't find that search.",
  circle: "We couldn't find that circle.",
  pod: "We couldn't find that pod.",
  event: "We couldn't find that event.",
  post: "We couldn't find that post.",
  comment: "We couldn't find that comment.",
} as const;

/** Check one part of the path, refusing with `sentence`; the path's other parts are kept as they are. */
export function checkPathPart(name: string, part: z.ZodTypeAny, sentence: string) {
  return validate(z.object({ [name]: part }).passthrough(), 'params', sentence);
}

/** A uuid, lower-cased. */
export const uuidPart = (sentence: string) => z.string().uuid(sentence).transform((s) => s.toLowerCase());

/** The path part `name` is a uuid, lower-cased; anything else is refused with `sentence`. */
export const uuidInPath = (name: string, sentence: string) => checkPathPart(name, uuidPart(sentence), sentence);
