// ─── When an invite stops working (21 Nov 2026, Ben Hotaling / Stefan) ───────────────────────────
//
// Ben scheduled his TRIIBE 100 event and pasted the pod's invite link into Luma: "Says its only valid for 7 days.
// We need something evergreen up until the event starts." Every link and email invite was made a week long by the
// client, whatever it led to. Now the server decides, so an old browser tab that still asks for a week gets the
// same answer as a new one:
//   - An invite to an event (link or email) has no timer. It ends with the event: accepting is refused once the
//     event is completed or cancelled (invite.service), and a rescheduled event keeps its invites working.
//   - A shareable link to a pod or a circle has no timer either. It lasts until its uses run out or an organiser
//     withdraws it.
//   - An email invite to one person for a pod or a circle, and a platform invite, keep the hours they were asked for
//     (a week from the invite sheet).

import { InviteType } from '@rsn/shared';

export interface InviteExpiryInput {
  type?: InviteType | null;
  /** True when the invite is a shareable link: it names no invitee. */
  isLink: boolean;
  expiresInHours?: number | null;
}

/** The moment the invite stops working, or null for no timer. */
export function inviteExpiresAt(input: InviteExpiryInput, now: Date = new Date()): Date | null {
  if (input.type === InviteType.SESSION) return null;
  if (input.isLink && (input.type === InviteType.POD || input.type === InviteType.CIRCLE)) return null;
  if (!input.expiresInHours) return null;
  return new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1000);
}
