// ─── Where a job title came from (13 Aug 2026, Task B1) ──────────────────────
//
// Stefan: "Bot pulls role/title from LinkedIn even when not explicitly set on
// the profile — needs a prompt fix so it doesn't misattribute roles."
//
// Two halves. The prompt must stop guessing a title. And because job_title is
// a MATCHING INPUT, a title that enrichment proposed and the member accepted
// unchanged must be distinguishable from one they typed or said themselves,
// so the matcher can prefer what they stated when it names an introduction.

const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../config', () => ({
  default: { anthropicApiKey: '', onboardingEnrichModel: 'm', onboardingEnrichFallbackModel: '' },
  __esModule: true,
}));

import { applyEnrichedToProfile, sameTitle } from '../../../services/onboarding/enrichment.repo';
import * as fs from 'fs';
import * as path from 'path';

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [] }); });

const sql = () => String(mockQuery.mock.calls[0][0]);
const params = () => mockQuery.mock.calls[0][1] as unknown[];

describe('applyEnrichedToProfile records where the title came from', () => {
  it('stamps inferred when told the accepted title was the enrichment proposal', async () => {
    await applyEnrichedToProfile('u-1', { jobTitle: 'Head of Growth' }, 'inferred');
    expect(sql()).toMatch(/job_title_source/);
    expect(params()).toContain('inferred');
  });

  it('stamps stated when the member edited the title on the card', async () => {
    await applyEnrichedToProfile('u-1', { jobTitle: 'Founder' }, 'stated');
    expect(params()).toContain('stated');
  });

  it('leaves provenance alone when no title is written (COALESCE keeps the column)', async () => {
    await applyEnrichedToProfile('u-1', { company: 'Acme' });
    // The provenance CASE is keyed on the title parameter: null title → unchanged.
    expect(sql()).toMatch(/job_title_source\s*=\s*CASE WHEN \$2::text IS NULL THEN job_title_source/);
    expect(params()[1]).toBeNull();
  });

  it('still only changes the fields it was given', async () => {
    await applyEnrichedToProfile('u-1', { company: 'Acme' });
    expect(sql()).toMatch(/job_title\s*=\s*COALESCE\(\$2, job_title\)/);
    expect(sql()).toMatch(/company\s*=\s*COALESCE\(\$3, company\)/);
  });
});

describe('sameTitle: "accepted unchanged" is a forgiving comparison', () => {
  it('ignores case, surrounding space and repeated spaces', () => {
    expect(sameTitle('Head of Growth', ' head  of growth ')).toBe(true);
  });
  it('is false for a real edit, and for anything missing', () => {
    expect(sameTitle('Head of Growth', 'Founder')).toBe(false);
    expect(sameTitle('Head of Growth', null)).toBe(false);
    expect(sameTitle(null, 'Head of Growth')).toBe(false);
    expect(sameTitle('', '')).toBe(false);
  });
});

describe('the enrichment prompt refuses to invent a role', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../services/onboarding/enrichment.service.ts'), 'utf8');

  it('tells the model to return a title only if it is stated, and null otherwise', () => {
    expect(src).toMatch(/currentRole ONLY if it is stated/i);
    expect(src).toMatch(/otherwise return null/i);
  });

  it('forbids deriving a title from company, industry or activity', () => {
    expect(src).toMatch(/do NOT infer a role or title/i);
  });

  it('prefers the title the person uses for themselves over the most senior-sounding one', () => {
    expect(src).toMatch(/the one the person uses for themselves/i);
  });
});
