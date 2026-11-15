// What the rating forms say (field test, 13 Nov 2026: "ratings clarity"). The live form after each conversation and
// the late form on an event's recap share these words. Pure, so a test can run it.
//
// Every sentence here was checked against what the other person is actually shown:
// - The stars: the end-of-event screen and the recap show a member only the stars they gave. A partner is never shown
//   the stars given to them. A host reads only how many of each there were across the event; an admin can read each one.
// - Meet again: when both choose it, it is a mutual match. When only one does, the other is shown "They wanted to
//   meet again" on their end-of-event screen and their recap.

export const STAR_MEANINGS = ['Not useful', 'Okay', 'Good', 'Very good', 'Excellent'] as const;
export const STAR_PROMPT = 'Tap a star to rate';

/** What a star means, for its accessible name. */
export function starLabel(n: number): string {
  return `${n} out of 5`;
}

/** The line under the stars: what the chosen value means, or how to choose one (it also says why Submit is off). */
export function starHint(rating: number): string {
  return STAR_MEANINGS[rating - 1] ?? STAR_PROMPT;
}

export const MEET_AGAIN_LABEL = 'I would meet again';
export const MEET_AGAIN_HELP = 'If you both choose to meet again, it is a mutual match. If only you do, they see that you wanted to.';
export const STARS_PRIVATE = 'Your stars are not shown to them.';
export const DIDNT_WORK_HELP = 'For a no-show or a call that failed. It does not count toward anyone’s ratings.';
