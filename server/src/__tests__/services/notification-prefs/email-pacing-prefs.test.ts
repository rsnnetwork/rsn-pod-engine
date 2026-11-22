// ─── The email pacing settings (22 Nov 2026, Stefan) ─────────────────────────────────────────────────────────
//
// notification_prefs held booleans only. "Only email me when I'm away" (email_away_only, on), "Most emails a day"
// (email_max_per_day: 1, 3, 5 or 10; 3) and "Weekly digest" (weekly_digest, on) join them. A row written before has
// none of the three and reads the defaults; a value of the wrong kind, or a maximum not offered, is never stored or read.

import { prefsFromStored, applyPrefsPatch, DEFAULT_PREFS } from '../../../services/notification-prefs/notification-prefs.service';
import { updateSchema } from '../../../routes/notification-prefs';

describe('reading what is stored', () => {
  it('a row written before the three settings reads their defaults: away only, three a day, the weekly digest on', () => {
    const prefs = prefsFromStored({ dm_bell: true, dm_email: false, poke_bell: true, poke_email: true });
    expect(prefs.email_away_only).toBe(true);
    expect(prefs.email_max_per_day).toBe(3);
    expect(prefs.weekly_digest).toBe(true);
    expect(prefs.dm_email).toBe(false);
  });

  it('nothing stored at all is every default', () => {
    expect(prefsFromStored(null)).toEqual(DEFAULT_PREFS);
    expect(prefsFromStored('garbage')).toEqual(DEFAULT_PREFS);
    expect(prefsFromStored([true])).toEqual(DEFAULT_PREFS);
  });

  it('a value of the wrong kind, or a daily maximum not offered, reads as the default', () => {
    const prefs = prefsFromStored({ email_away_only: 'no', email_max_per_day: 7, weekly_digest: 0, dm_email: 'false' });
    expect(prefs.email_away_only).toBe(true);
    expect(prefs.email_max_per_day).toBe(3);
    expect(prefs.weekly_digest).toBe(true);
    expect(prefs.dm_email).toBe(true);
  });

  it.each([1, 3, 5, 10])('keeps a daily maximum of %i', (n) => {
    expect(prefsFromStored({ email_max_per_day: n }).email_max_per_day).toBe(n);
  });
});

describe('saving a change', () => {
  it('changes what was asked and nothing else', () => {
    const next = applyPrefsPatch(DEFAULT_PREFS, { email_max_per_day: 10, weekly_digest: false });
    expect(next).toEqual({ ...DEFAULT_PREFS, email_max_per_day: 10, weekly_digest: false });
  });

  it('ignores a value of the wrong kind, a maximum not offered and a key it does not know', () => {
    const next = applyPrefsPatch(DEFAULT_PREFS, { email_max_per_day: 4, email_away_only: 'off', unknown: true } as never);
    expect(next).toEqual(DEFAULT_PREFS);
  });
});

describe('the route\'s validation', () => {
  it('accepts the three settings with their own kinds', () => {
    expect(updateSchema.parse({ email_away_only: false, email_max_per_day: 5, weekly_digest: false }))
      .toEqual({ email_away_only: false, email_max_per_day: 5, weekly_digest: false });
  });

  it.each([0, 2, 4, 11, '3', 3.5])('refuses a daily maximum of %p', (n) => {
    expect(updateSchema.safeParse({ email_max_per_day: n }).success).toBe(false);
  });

  it('refuses a switch that is not true or false', () => {
    expect(updateSchema.safeParse({ weekly_digest: 'yes' }).success).toBe(false);
  });
});
