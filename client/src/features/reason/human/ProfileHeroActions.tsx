// client/src/features/reason/human/ProfileHeroActions.tsx
// The actions under a connection's name in the hero (30 Oct 2026, Stefan: "When I open a connection's
// profile, there should be a 'Message' button to message them directly"). One row, so the next action
// (a direct video call) sits beside Message here.
//
// Only for people the viewer is connected to or has met, so an admin's view of a stranger is unchanged
// although an admin may message anyone. Message is offered only when the server says it can send
// (brief.canMessage, the rule GET /dm/can-message/:userId applies): two people who met at an event
// without both saying "meet again" are told why instead of being handed a button that cannot send.
// The brief carries the answer, so the button arrives with the profile and never loads on its own.
import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import type { PersonBrief } from '@rsn/shared';

export const NOT_MUTUAL_SENTENCE = 'Messages open when you both say you would meet again';

export default function ProfileHeroActions({ brief, userId }: { brief: PersonBrief; userId: string }) {
  const { state } = brief.relationship;
  if (state !== 'connected' && state !== 'met') return null;
  if (!brief.canMessage) {
    return brief.canMessageReason === 'not_mutual'
      ? <p className="mt-3 text-[13px] text-reason-muted [overflow-wrap:anywhere]" data-testid="message-closed">{NOT_MUTUAL_SENTENCE}</p>
      : null;
  }
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="profile-hero-actions">
      <Link
        to={`/messages/new/${userId}`}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white hover:bg-reason-red-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-reason-red focus-visible:ring-offset-2"
      >
        <MessageCircle className="h-4 w-4" aria-hidden="true" /> Message
      </Link>
    </div>
  );
}
