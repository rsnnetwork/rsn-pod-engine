// ─── Public card projection (Stefan, 9 Sep 2026) ─────────────────────────────
// The onboarding-built profile (why I'm here, who I want to meet, interests…)
// is private: only the member and admins see it. Everyone else gets the
// public card — a strict subset. This is THE projection every "another
// member" read path must go through, so pin its exact shape.

import { toPublicMember, toPublicIntentProfile, withoutEmail, PRIVATE_MEMBER_KEYS } from '../../../services/user/public-card';
import type { IntentProfile } from '../../../services/matching/platform-match.service';

const full = {
  id: 'u-1',
  email: 'secret@example.com',
  phone: '+49 123',
  displayName: 'Dana Sender',
  firstName: 'Dana',
  lastName: 'Sender',
  avatarUrl: 'https://a/x.png',
  bio: 'I build robots.',
  company: 'Acme Robotics',
  jobTitle: 'Senior React Developer',
  industry: 'Robotics',
  location: 'Berlin',
  linkedinUrl: 'https://linkedin.com/in/dana',
  languages: ['en', 'de'],
  timezone: 'Europe/Berlin',
  professionalRole: ['Developer'],
  expertiseText: 'react, typescript, distributed systems',
  whatICanHelpWith: 'frontend architecture reviews',
  // private
  interests: ['sailing', 'chess'],
  reasonsToConnect: ['find a cofounder'],
  whatICareAbout: 'climate',
  whoIWantToMeet: 'founders who need a technical partner',
  whyIWantToMeet: 'to join an early team',
  myIntent: 'become a CTO',
  goals: ['cto'],
  matchingNotes: 'AI summary',
  careerStage: 'senior',
  currentState: 'looking',
  meetingPreferences: ['video'],
  invitedByUserId: 'u-0',
  notifyEmail: true,
  notifyEventReminders: true,
  notifyMatches: true,
  profileVisible: true,
  inviteOptOutPublicEvents: false,
  onboardingStatus: 'completed',
  lastOnboardedAt: '2026-09-01',
  role: 'member',
  status: 'active',
  profileComplete: true,
  emailVerified: true,
  lastActiveAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as any;

describe('toPublicMember', () => {
  it('keeps who they are and what they offer', () => {
    const pub = toPublicMember(full);
    expect(pub).toEqual({
      id: 'u-1',
      displayName: 'Dana Sender',
      firstName: 'Dana',
      lastName: 'Sender',
      avatarUrl: 'https://a/x.png',
      bio: 'I build robots.',
      company: 'Acme Robotics',
      jobTitle: 'Senior React Developer',
      industry: 'Robotics',
      location: 'Berlin',
      linkedinUrl: 'https://linkedin.com/in/dana',
      languages: ['en', 'de'],
      professionalRole: ['Developer'],
      expertiseText: 'react, typescript, distributed systems',
      whatICanHelpWith: 'frontend architecture reviews',
    });
  });

  it('never carries a private key — why they are here, wants, interests, contact, prefs', () => {
    const pub = toPublicMember(full) as unknown as Record<string, unknown>;
    for (const k of PRIVATE_MEMBER_KEYS) {
      expect(pub).not.toHaveProperty(k);
    }
    // Belt and braces: the exact list, so adding a private column without
    // adding it here fails loudly.
    expect([...PRIVATE_MEMBER_KEYS].sort()).toEqual([
      'careerStage', 'currentState', 'email', 'goals', 'interests', 'inviteOptOutPublicEvents',
      'invitedByUserId', 'lastOnboardedAt', 'matchingNotes', 'meetingPreferences', 'myIntent',
      'notifyEmail', 'notifyEventReminders', 'notifyMatches', 'onboardingStatus', 'phone',
      'profileVisible', 'reasonsToConnect', 'timezone', 'whatICareAbout', 'whoIWantToMeet',
      'whyIWantToMeet',
    ]);
  });

  it('tolerates a sparse row (nulls and missing arrays)', () => {
    const pub = toPublicMember({ id: 'u-2', displayName: 'X' } as any);
    expect(pub.id).toBe('u-2');
    expect(pub.languages).toEqual([]);
    expect(pub.professionalRole).toEqual([]);
    expect(pub.bio).toBeNull();
    expect(pub).not.toHaveProperty('email');
  });
});

// What a matching scorer may read about ANOTHER member when the screen can be aimed at any
// member by id (the Human Profile brief). The scorer counts interests and what a member
// cares about as things they offer, and words its reason from whatever matched, so a scorer
// handed those fields spells them out to whoever is looking.
describe('toPublicIntentProfile', () => {
  const profile: IntentProfile & { onboardingCompleted: boolean } = {
    id: 'u-1', displayName: 'Dana Sender', avatarUrl: 'https://a/x.png',
    professionalRole: ['Developer'], jobTitle: 'Senior React Developer', jobTitleSource: 'stated',
    company: 'Acme Robotics', expertiseText: 'react, typescript', whatICanHelpWith: 'frontend architecture reviews',
    industry: 'Robotics', bio: 'I build robots.', location: 'Berlin',
    // private to the member
    whatICareAbout: 'climate', goals: ['cto'], interests: ['sailing', 'chess'],
    myIntent: 'become a CTO', whoIWantToMeet: 'founders who need a technical partner', whyIWantToMeet: 'to join an early team',
    // not part of the scorer's profile at all
    onboardingCompleted: true,
  };
  const asRecord = (p: IntentProfile) => p as unknown as Record<string, unknown>;

  it('keeps what is on the public card, and the title provenance the reason is worded with', () => {
    expect(toPublicIntentProfile(profile)).toMatchObject({
      id: 'u-1', displayName: 'Dana Sender', avatarUrl: 'https://a/x.png',
      professionalRole: ['Developer'], jobTitle: 'Senior React Developer', jobTitleSource: 'stated',
      company: 'Acme Robotics', expertiseText: 'react, typescript', whatICanHelpWith: 'frontend architecture reviews',
      industry: 'Robotics', bio: 'I build robots.', location: 'Berlin',
    });
  });

  it('empties every private field: why they are here, what they want, what they care about', () => {
    const out = toPublicIntentProfile(profile);
    for (const key of ['whatICareAbout', 'goals', 'interests', 'myIntent', 'whoIWantToMeet', 'whyIWantToMeet']) {
      expect(asRecord(out)[key]).toBeNull();
    }
    expect(JSON.stringify(out)).not.toMatch(/climate|cto|sailing|chess|technical partner|early team/i);
  });

  it('is held to the same private list as the public card: no private key carries a value', () => {
    const out = asRecord(toPublicIntentProfile(profile));
    for (const key of PRIVATE_MEMBER_KEYS) if (key in out) expect(out[key]).toBeNull();
  });

  it('has no value that the public card itself does not have', () => {
    const card = toPublicMember(profile as unknown as Parameters<typeof toPublicMember>[0]);
    for (const [key, value] of Object.entries(toPublicIntentProfile(profile))) {
      if (value === null || key === 'jobTitleSource') continue; // a provenance flag, not something about the member
      expect(Object.keys(card)).toContain(key);
    }
  });

  it('drops anything it was not told to carry, and is a copy', () => {
    const withNewField = { ...profile, somethingAddedLater: 'private until someone decides otherwise' };
    const out = toPublicIntentProfile(withNewField);
    expect(out).not.toHaveProperty('somethingAddedLater');
    expect(out).not.toHaveProperty('onboardingCompleted');
    expect(out).not.toBe(withNewField);
  });

  it('tolerates a sparse profile: nothing missing becomes undefined', () => {
    const out = asRecord(toPublicIntentProfile({ id: 'u-2' } as IntentProfile));
    expect(out.id).toBe('u-2');
    for (const [key, value] of Object.entries(out)) if (key !== 'id') expect({ key, value }).toEqual({ key, value: null });
  });
});

describe('withoutEmail', () => {
  it('drops email (and interests) from a member/participant row list', () => {
    const rows = [
      { userId: 'a', displayName: 'A', email: 'a@x', avatarUrl: null, jobTitle: 'CEO', company: 'Co', interests: ['x'] },
      { userId: 'b', displayName: 'B', email: 'b@x', avatarUrl: null, jobTitle: null, company: null },
    ];
    const out = withoutEmail(rows);
    expect(out).toEqual([
      { userId: 'a', displayName: 'A', avatarUrl: null, jobTitle: 'CEO', company: 'Co' },
      { userId: 'b', displayName: 'B', avatarUrl: null, jobTitle: null, company: null },
    ]);
    // input untouched
    expect(rows[0]).toHaveProperty('email');
  });
});
