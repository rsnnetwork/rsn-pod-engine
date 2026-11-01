// ─── The words on the live room's state chip ───────────────────────────────────────────────────────
//
// The chip in the live top bar says where the event is ("Main Room · Round 1 of 5"). On a phone that
// full text took half the bar and left the event's title no room at all, so there is also a short text
// for screens under 640px ("Round 1/5"); the full text stays for screen readers and as the chip's title.

const LABELS: Record<string, string> = {
  scheduled: 'Waiting to start',
  lobby_open: 'Main Room',
  round_active: 'Breakout Rooms · Round {round}',
  round_rating: 'Rating',
  round_transition: 'Main Room',
  // closing_lobby: no label of its own; the "Round X of Y" suffix carries the context.
  closing_lobby: '',
  completed: 'Event ended',
};

/** The chip's full text and its short text for phones, for the event's status and round. */
export function eventStateChipText(sessionStatus: string, currentRound: number, totalRounds: number): { full: string; short: string } {
  const status = sessionStatus in LABELS ? sessionStatus : 'scheduled';
  const round = currentRound || 1;
  const label = LABELS[status].replace('{round}', String(round));
  const counted = totalRounds > 0 && status !== 'completed' && status !== 'scheduled';
  const roundInfo = counted ? `Round ${round} of ${totalRounds}` : '';
  // The round is not said twice when the label already names it (a breakout round).
  const showRoundInfo = roundInfo !== '' && !label.includes(`Round ${round}`);
  const full = label && showRoundInfo ? `${label} · ${roundInfo}` : label || (showRoundInfo ? roundInfo : '');

  if (counted) return { full, short: status === 'round_rating' ? `Rating ${round}/${totalRounds}` : `Round ${round}/${totalRounds}` };
  if (status === 'round_active') return { full, short: `Round ${round}` };
  return { full, short: full };
}
