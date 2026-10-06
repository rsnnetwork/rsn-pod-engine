import type { PrimaryAction, RelationshipState } from '@rsn/shared';

export const PRIMARY_LABEL: Record<PrimaryAction, string> = {
  meet: 'Meet', requested: 'Request sent', respond: 'Respond', declined: 'Request declined', continue: 'Continue',
};

export const STATE_LABEL: Record<RelationshipState, string> = {
  none: 'New relationship', requested: 'Meeting requested', incoming: 'They asked to meet you',
  declined: 'Request declined', connected: 'Connected', met: 'Met',
};

export const NEXT_MOVE: Record<RelationshipState, string> = {
  none: 'Decide whether there is a reason to meet.',
  requested: 'Wait for their answer, then have the conversation.',
  incoming: 'They asked to meet you. Answer in Messages.',
  declined: 'They declined your earlier request.',
  connected: 'Pick a time together in Messages.',
  met: 'Record what happened, then continue while the reason is live.',
};
