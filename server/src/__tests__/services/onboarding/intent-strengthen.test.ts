// 14 Sep 2026 (Ali, after the full-flow smoke): "its not only about getting
// photo at login also linkedIn whole data so profile is strong". The
// extractor read the chat only; a rich LinkedIn plus a two-word chat left a
// weak profile. What we hold fills what the chat left empty, never the other
// way round, and a headline never becomes a title.

import { knownForIntent, strengthenIntent, hasKnownFacts } from '../../../services/onboarding/intent-strengthen';
import type { EnrichedProfile } from '../../../services/onboarding/enrichment.service';
import type { ExtractedIntent } from '../../../services/onboarding/intent.schema';

const gates: EnrichedProfile = {
  fullName: 'Bill Gates', headline: null, currentRole: 'Chair of the Gates Foundation', currentCompany: 'Gates Foundation',
  industry: 'Philanthropy', location: 'Seattle, Washington', summary: 'Chair of the Gates Foundation. Founder of Breakthrough Energy. Co-founder of Microsoft. Voracious reader.',
  pastRoles: ['Co-founder at Microsoft'], education: [], skills: ['Philanthropy', 'Software', 'Global health'],
  likelyWantsToMeet: ['global health founders', 'climate investors'], likelyOffers: ['funding', 'strategy'],
  conversationStarters: [], questionsToVerify: [], linkedinUrl: 'https://www.linkedin.com/in/williamhgates', photoUrl: null,
};

/** What the extractor reads out of "networking" + "blogs". */
const thin = (): ExtractedIntent => ({
  desiredPeople: [], desiredRoles: [], desiredSeniority: [], desiredStage: [], desiredIndustries: [],
  reasonForMeeting: 'Networking', desiredOutcome: '', userProfileSummary: '', userRole: '', userCompany: 'VOKT', userIndustry: null,
  userLocation: null, userExpertise: [], userCanOffer: [], userInterests: ['blogs'], userCity: null, userValuableTo: [],
  suggestedInvitees: [], currentFocus: 'blogs at VOKT', matchPriority: 'low', userDesignation: '', desiredDesignations: [],
  avoidDesignations: [], avoidPreferences: [], privacyRecommendation: '', matchingTags: ['vokt', 'blogs', 'networking'],
  embeddingText: '', confidenceScores: { desiredPeople: 0, reasonForMeeting: 0.3, userProfile: 0.1 }, profileStrength: 'weak',
  userLanguages: [], problemTheySolve: '', authorityLevel: '', needsHelpWith: [], meetingValueCriteria: '', timeHorizon: '',
  restrictions: { noCompetitors: false, competitorNote: null, geography: [], industriesToAvoid: [], seniorityToAvoid: [], requiredLanguages: [] },
});

describe('knownForIntent', () => {
  it('reads the enrichment, and a saved title, industry or bio wins over the scrape', () => {
    const k = knownForIntent(gates, { role: 'Chair', industry: null, about: null, interests: ['Reading'] }, 'Bill Gates');
    expect(k.role).toBe('Chair');
    expect(k.company).toBe('Gates Foundation');
    expect(k.industry).toBe('Philanthropy');
    expect(k.about).toContain('Chair of the Gates Foundation');
    expect(k.skills).toEqual(['Reading', 'Philanthropy', 'Software', 'Global health']);
    expect(hasKnownFacts(k)).toBe(true);
    expect(hasKnownFacts(knownForIntent(null))).toBe(false);
  });
});

describe('strengthenIntent', () => {
  it('fills what a thin chat left empty from the LinkedIn result, and keeps what the member said', () => {
    const out = strengthenIntent(thin(), knownForIntent(gates));
    expect(out.userRole).toBe('Chair of the Gates Foundation');
    expect(out.userCompany).toBe('VOKT');
    expect(out.userIndustry).toBe('Philanthropy');
    expect(out.userLocation).toBe('Seattle, Washington');
    expect(out.userExpertise).toEqual(['Philanthropy', 'Software', 'Global health']);
    expect(out.userInterests).toEqual(['blogs']);
    expect(out.userCanOffer).toEqual(['funding', 'strategy']);
    expect(out.userProfileSummary).toBe('Chair of the Gates Foundation. Founder of Breakthrough Energy.');
    // Nothing said about who: LinkedIn's likely wants, as the last fallback.
    expect(out.desiredPeople).toEqual(['global health founders', 'climate investors']);
    expect(out.confidenceScores.desiredPeople).toBe(0.3);
    expect(out.confidenceScores.userProfile).toBe(0.7);
    expect(out.embeddingText).toContain('Chair of the Gates Foundation at VOKT');
    expect(out.embeddingText).toContain('Wants to meet global health founders');
    expect(out.matchingTags).toEqual(['vokt', 'blogs', 'networking', 'philanthropy', 'software', 'global health']);
    expect(out.reasonForMeeting).toBe('Networking');
  });

  it('never overwrites what the chat produced', () => {
    const rich = { ...thin(), userRole: 'Writer', desiredPeople: ['editors'], userExpertise: ['writing'], userProfileSummary: 'A writer.', embeddingText: 'A writer who wants editors.', matchingTags: ['a', 'b', 'c', 'd', 'e'] };
    const out = strengthenIntent(rich, knownForIntent(gates));
    expect(out.userRole).toBe('Writer');
    expect(out.desiredPeople).toEqual(['editors']);
    expect(out.userExpertise).toEqual(['writing']);
    expect(out.userProfileSummary).toBe('A writer.');
    expect(out.embeddingText).toBe('A writer who wants editors.');
    expect(out.matchingTags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a headline is not a title: with no stated role the role stays empty, and the headline becomes the summary', () => {
    const out = strengthenIntent(thin(), knownForIntent({ ...gates, currentRole: null, summary: null, headline: 'Curious about everything' }));
    expect(out.userRole).toBe('');
    expect(out.userProfileSummary).toBe('Curious about everything');
  });

  it('roles named in the chat keep LinkedIn\'s likely wants out', () => {
    const out = strengthenIntent({ ...thin(), desiredRoles: ['editor'] }, knownForIntent(gates));
    expect(out.desiredPeople).toEqual([]);
    expect(out.desiredRoles).toEqual(['editor']);
  });

  it('tolerates a partial intent and returns it unchanged when nothing is known', () => {
    const partial = { userRole: 'Founder' } as Partial<ExtractedIntent>;
    expect(strengthenIntent(partial, knownForIntent(null))).toBe(partial);
    const out = strengthenIntent(partial, knownForIntent(gates));
    expect(out.userRole).toBe('Founder');
    expect(out.userCompany).toBe('Gates Foundation');
  });

  it('the join-request reason fills an empty reason', () => {
    const out = strengthenIntent({ ...thin(), reasonForMeeting: '' }, knownForIntent(null, { whyHere: 'to meet founders in climate' }));
    expect(out.reasonForMeeting).toBe('to meet founders in climate');
  });
});

// 14 Sep 2026 (Ali: "get all info which is available on the LinkedIn page"):
// certifications, volunteering, publications, languages and followers reach
// the intent too. Shradha's page had no headline, no About and no positions,
// but four certifications and a volunteering role.
describe('the rest of the LinkedIn page', () => {
  const shradha: EnrichedProfile = {
    fullName: 'Shradha Adhikari', headline: null, currentRole: null, currentCompany: 'Vokt', industry: null, location: null,
    summary: null, pastRoles: [], education: [], skills: [], likelyWantsToMeet: [], likelyOffers: [], conversationStarters: [],
    questionsToVerify: [], linkedinUrl: 'https://www.linkedin.com/in/shradhadhikari', photoUrl: null,
    certifications: ['Python for Data Science, AI & Development (IBM, Jul 2025)', 'Business Development Foundations (LinkedIn, Mar 2025)', 'Sales: Practical Techniques (LinkedIn, Feb 2025)'],
    volunteering: ['Researcher at Robin Hood Army'], languages: ['English', 'Nepali'], publications: [], projects: [], awards: [], courses: [], organizations: [],
    educationText: [], followers: '4K followers',
    highlights: ['Certified: Python for Data Science, AI & Development (IBM, Jul 2025); Business Development Foundations (LinkedIn, Mar 2025); Sales: Practical Techniques (LinkedIn, Feb 2025)', 'Volunteers as Researcher at Robin Hood Army', 'Speaks English, Nepali', '4K followers on LinkedIn'],
  };

  it('certifications become expertise, the page lines stand in for a missing About, languages are carried', () => {
    const k = knownForIntent(shradha);
    expect(k.skills).toEqual(['Python for Data Science, AI & Development', 'Business Development Foundations', 'Sales: Practical Techniques']);
    expect(k.highlights).toHaveLength(4);
    expect(hasKnownFacts(k)).toBe(true);
    const out = strengthenIntent({ ...thin(), userInterests: [], userCompany: '' }, k);
    expect(out.userCompany).toBe('Vokt');
    expect(out.userRole).toBe('');
    expect(out.userExpertise).toEqual(['Python for Data Science, AI & Development', 'Business Development Foundations', 'Sales: Practical Techniques']);
    expect(out.userProfileSummary).toBe('Certified: Python for Data Science, AI & Development (IBM, Jul 2025); Business Development Foundations (LinkedIn, Mar 2025); Sales: Practical Techniques (LinkedIn, Feb 2025). Volunteers as Researcher at Robin Hood Army');
    expect(out.userLanguages).toEqual(['English', 'Nepali']);
    expect(out.embeddingText).toContain('at Vokt');
    expect(out.confidenceScores.userProfile).toBe(0.7);
  });
});
