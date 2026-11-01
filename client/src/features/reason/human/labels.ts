import type { PrimaryAction, RelationshipState } from '@rsn/shared';

export const PRIMARY_LABEL: Record<PrimaryAction, string> = {
  meet: 'Meet', requested: 'Request sent', respond: 'Respond', declined: 'Request declined',
  // 30 Oct 2026 (Stefan): "Rename 'Continue' to 'Message' after a connection is made." The key stays continue.
  continue: 'Message',
};

export const STATE_LABEL: Record<RelationshipState, string> = {
  none: 'New relationship', requested: 'Meeting requested', incoming: 'They asked to meet you',
  declined: 'Request declined', connected: 'Connected', met: 'Met',
};

export const NEXT_MOVE: Record<RelationshipState, string> = {
  none: 'Decide whether there is a reason to meet.',
  requested: 'Wait for their answer, then have the conversation.',
  incoming: 'They asked to meet you. Accept or decline here.',
  declined: 'They declined your earlier request.',
  connected: 'Message them, and pick a time together.',
  met: 'Record what happened, then message them while the reason is live.',
};
