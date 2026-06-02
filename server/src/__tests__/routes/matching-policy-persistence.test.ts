// 26 May live test — host chose "Platform-wide no rematch" but the session
// persisted with matchingPolicy='within_event', so prior-event pairs were
// re-matched. Root cause: the route's zod config schema omitted
// `matchingPolicy`, and zod strips unknown keys — so the field was silently
// dropped at validation before reaching session.service. These tests pin that
// the schema PRESERVES matchingPolicy on create and update.

import { createSessionSchema, updateSessionSchema } from '../../routes/sessions';

describe('session config schema preserves matchingPolicy', () => {
  const baseCreate = {
    podId: '11111111-1111-1111-1111-111111111111',
    title: 'Test',
    scheduledAt: '2026-05-27T10:00:00.000Z',
  };

  it('createSessionSchema keeps config.matchingPolicy = platform_wide', () => {
    const parsed = createSessionSchema.parse({
      ...baseCreate,
      config: { numberOfRounds: 3, matchingPolicy: 'platform_wide' },
    });
    expect(parsed.config?.matchingPolicy).toBe('platform_wide');
  });

  it('createSessionSchema accepts all three policy values', () => {
    for (const policy of ['platform_wide', 'within_event', 'none'] as const) {
      const parsed = createSessionSchema.parse({ ...baseCreate, config: { matchingPolicy: policy } });
      expect(parsed.config?.matchingPolicy).toBe(policy);
    }
  });

  it('createSessionSchema rejects an invalid policy value', () => {
    expect(() => createSessionSchema.parse({
      ...baseCreate,
      config: { matchingPolicy: 'bogus' },
    })).toThrow();
  });

  it('updateSessionSchema keeps config.matchingPolicy = platform_wide', () => {
    const parsed = updateSessionSchema.parse({ config: { matchingPolicy: 'platform_wide' } });
    expect(parsed.config?.matchingPolicy).toBe('platform_wide');
  });
});
