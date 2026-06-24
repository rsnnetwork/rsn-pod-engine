import { FIRST_QUESTION, buildHostSystemPrompt } from '../../../services/onboarding/prompts';

const EM_OR_EN_DASH = /[—–]/;

describe('onboarding prompts (v1.1)', () => {
  it('the first chat question contains no dashes', () => {
    expect(EM_OR_EN_DASH.test(FIRST_QUESTION)).toBe(false);
    expect(FIRST_QUESTION.includes(' - ')).toBe(false);
  });

  it('the host system prompt forbids dashes', () => {
    const p = buildHostSystemPrompt().toLowerCase();
    expect(p).toContain('never use dashes');
  });

  it('weaves the confirmed profile in so the host never re-asks', () => {
    const p = buildHostSystemPrompt({ name: 'Stefan', country: 'Denmark', company: 'Mister Raw' });
    expect(p).toContain('Stefan');
    expect(p).toContain('Denmark');
    expect(p).toContain('Mister Raw');
    expect(p).toContain('CONFIRMED');
  });

  it('omits the known block when no profile is given', () => {
    expect(buildHostSystemPrompt()).not.toContain('CONFIRMED');
  });
});
