import { buildMessage } from '../../../services/post-event-message/templates';

describe('buildMessage', () => {
  const ctx = { firstName: 'Ian', eventTitle: 'The 1st big test of reason', eventDate: 'Tuesday, 27 May 2026', senderName: 'Stefan' };

  it('fills first name, event and date into the stayed template', () => {
    const msg = buildMessage('stayed', ctx);
    expect(msg).toContain('Ian');
    expect(msg).toContain('The 1st big test of reason');
    expect(msg).toContain('Tuesday, 27 May 2026');
    expect(msg.length).toBeGreaterThan(40);
  });

  it('produces distinct copy per bucket', () => {
    const buckets = ['stayed','left_early','could_not_join','no_show'] as const;
    const msgs = buckets.map(b => buildMessage(b, ctx));
    expect(new Set(msgs).size).toBe(4);
  });

  it('falls back to "there" when first name missing', () => {
    expect(buildMessage('stayed', { ...ctx, firstName: '' })).toContain('Hi there');
  });
});
