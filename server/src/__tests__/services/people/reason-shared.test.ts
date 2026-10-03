import { primaryActionFor, OUTCOME_KEYS, OUTCOME_LABELS, MEETING_FORMATS } from '@rsn/shared';

describe('REASON shared vocabulary (milestone 1)', () => {
  it.each([
    ['none', 'meet'],
    ['requested', 'requested'],
    ['incoming', 'respond'],
    ['declined', 'declined'],
    ['connected', 'continue'],
    ['met', 'continue'],
  ] as const)('state %s offers %s', (state, action) => {
    expect(primaryActionFor(state)).toBe(action);
  });

  it('outcomes are exactly the Foundation S10 list, each with a label', () => {
    expect([...OUTCOME_KEYS]).toEqual([
      'follow_up', 'introduction', 'potential_customer', 'potential_partnership',
      'advice', 'investment', 'hiring', 'friendship', 'nothing_yet',
    ]);
    for (const k of OUTCOME_KEYS) expect(OUTCOME_LABELS[k]).toBeTruthy();
  });

  it('meeting formats are the three the v4 prototype offers', () => {
    expect(MEETING_FORMATS.map(f => f.label)).toEqual([
      '20 minute video conversation', 'In person coffee', 'Message first',
    ]);
  });
});
