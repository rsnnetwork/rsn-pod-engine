// server/src/__tests__/client/reason-your-profile.test.ts
// "Your profile, the way others see it, with edit and a banner you can change" (21 Oct 2026; Stefan: "when I
// look at my profile, I should see my profile, how other people see it - and then edit, where applicable", and
// the 19 Oct feedback: "Users should be able to change their banner from their profile").
//
// The rules (the banner crop, what each part of the page says) live in modules with no React, axios, store or
// router behind them, and are run here. The markup and wiring need a browser, so they are read from the source,
// like the other client tests; the local e2e spec presses everything for real.
import * as fs from 'fs';
import * as path from 'path';
import type { PersonBrief } from '@rsn/shared';
import {
  BANNER_HEIGHT, BANNER_INPUT_MAX_BYTES, BANNER_QUALITY, BANNER_TYPES, BANNER_WIDTH, bannerCrop, bannerFileProblem,
} from '../../../../client/src/features/reason/profile/banner-image';
import {
  ADD_COMPANY_TO, CONNECT_LINKEDIN_TO, EDIT_ANSWERS_TO, EDIT_PROFILE_TO, needsLinkedin, privateRows, youCanBring,
} from '../../../../client/src/features/reason/profile/your-profile-text';
import { personFacts } from '../../../../client/src/features/reason/human/profile-text';

const CLIENT = path.join(__dirname, '../../../../client/src');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const page = () => read('features/reason/profile/YourProfilePage.tsx');
const editor = () => read('features/reason/profile/BannerEditor.tsx');
const banner = () => read('features/reason/human/ProfileBanner.tsx');
const human = () => read('features/reason/human/HumanProfilePage.tsx');
const more = () => read('features/reason/human/ProfileMoreMenu.tsx');
const form = () => read('features/profile/ProfilePage.tsx');
const app = () => read('App.tsx');
const api = () => read('features/reason/api.ts');
const count = (src: string, re: RegExp) => src.match(re)?.length ?? 0;

type Person = PersonBrief['person'];
const person = (over: Partial<Person> = {}): Person => ({
  id: '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03', displayName: 'Nora None', firstName: 'Nora', lastName: 'None', avatarUrl: null,
  bannerUrl: null, bio: null, company: null, jobTitle: null, industry: null, location: null, linkedinUrl: null, languages: [],
  professionalRole: [], expertiseText: null, whatICanHelpWith: null, ...over,
});

// ── The banner picture ────────────────────────────────────────────────────────────────────────────

describe('the banner is cropped to 1500 by 500 in the browser, from the middle of the picture', () => {
  it('is a 1500x500 JPEG at quality 0.85, from a JPG, PNG or WebP', () => {
    expect([BANNER_WIDTH, BANNER_HEIGHT, BANNER_QUALITY]).toEqual([1500, 500, 0.85]);
    expect([...BANNER_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('takes the widest 3:1 strip of a tall picture, centred top to bottom', () => {
    expect(bannerCrop(1200, 1600)).toEqual({ sx: 0, sy: 600, sw: 1200, sh: 400 });
  });

  it('takes the tallest 3:1 strip of a very wide picture, centred side to side', () => {
    expect(bannerCrop(4000, 1000)).toEqual({ sx: 500, sy: 0, sw: 3000, sh: 1000 });
  });

  it('keeps all of a picture that is already 3:1, at any size', () => {
    expect(bannerCrop(1500, 500)).toEqual({ sx: 0, sy: 0, sw: 1500, sh: 500 });
    expect(bannerCrop(300, 100)).toEqual({ sx: 0, sy: 0, sw: 300, sh: 100 });
  });

  it('always cuts a 3:1 strip that lies inside the picture', () => {
    for (const [w, h] of [[1, 1], [3000, 2000], [2000, 3000], [640, 480], [1920, 1080], [5000, 1], [1, 5000]]) {
      const c = bannerCrop(w, h);
      expect(c.sw / c.sh).toBeCloseTo(3, 6);
      expect(c.sx).toBeGreaterThanOrEqual(0);
      expect(c.sy).toBeGreaterThanOrEqual(0);
      expect(c.sx + c.sw).toBeLessThanOrEqual(w + 1e-9);
      expect(c.sy + c.sh).toBeLessThanOrEqual(h + 1e-9);
    }
  });

  it('says what is wrong with a file before anything is read: its type, or a size past 20 MB', () => {
    expect(BANNER_INPUT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(bannerFileProblem({ type: 'image/png', size: 4_000_000 })).toBeNull();
    expect(bannerFileProblem({ type: 'image/jpeg', size: BANNER_INPUT_MAX_BYTES })).toBeNull();
    expect(bannerFileProblem({ type: 'image/gif', size: 10 })).toBe('Choose a JPG, PNG or WebP picture for your banner.');
    expect(bannerFileProblem({ type: '', size: 10 })).toBe('Choose a JPG, PNG or WebP picture for your banner.');
    expect(bannerFileProblem({ type: 'image/webp', size: BANNER_INPUT_MAX_BYTES + 1 })).toBe('Choose a picture under 20 MB.');
  });
});

// ── What the page says ────────────────────────────────────────────────────────────────────────────

describe('Your profile: what it says', () => {
  it('"What you can bring" is your offer, or your expertise when you have not written one, as others are shown it', () => {
    expect(youCanBring({ whatICanHelpWith: ' Intros to retail buyers ', expertiseText: 'pricing' })).toBe('Intros to retail buyers');
    expect(youCanBring({ whatICanHelpWith: '   ', expertiseText: ' pricing ' })).toBe('pricing');
    expect(youCanBring({ whatICanHelpWith: null, expertiseText: null })).toBeNull();
  });

  it('"Only you see this": who you want to meet, what you are hoping to find, and your time zone, each saying when it is empty', () => {
    expect(privateRows({ whoIWantToMeet: ' Founders in fintech ', myIntent: 'to raise funding', whyIWantToMeet: 'ignored', timezone: 'Europe/Berlin' }))
      .toEqual([
        { label: 'Who you want to meet', value: 'Founders in fintech', empty: 'Not answered yet.' },
        { label: "What you're hoping to find", value: 'to raise funding', empty: 'Not answered yet.' },
        { label: 'Time zone', value: 'Europe/Berlin', empty: 'Not set yet.' },
      ]);
    // An older profile may have said why they want to meet people and nothing as an intent.
    expect(privateRows({ whoIWantToMeet: null, myIntent: ' ', whyIWantToMeet: 'Find a cofounder', timezone: null }).map((r) => r.value))
      .toEqual([null, 'Find a cofounder', null]);
  });

  it('the LinkedIn card shows only while there is no LinkedIn on the card', () => {
    expect(needsLinkedin({ linkedinUrl: null })).toBe(true);
    expect(needsLinkedin({ linkedinUrl: '   ' })).toBe(true);
    expect(needsLinkedin({ linkedinUrl: 'https://linkedin.com/in/nora' })).toBe(false);
  });

  it('every link goes where the brief says', () => {
    expect([EDIT_PROFILE_TO, EDIT_ANSWERS_TO, ADD_COMPANY_TO, CONNECT_LINKEDIN_TO])
      .toEqual(['/profile/edit', '/onboarding?edit=q1', '/entities?create=1', '/profile/edit#linkedin']);
  });

  it('the hero lists the industry, then the location, then the roles, at most four, on your page and on everyone else\'s', () => {
    expect(personFacts(person({ industry: 'Fintech', location: ' Berlin, DE ', professionalRole: ['Investor', 'Advisor'] })).tags)
      .toEqual(['Fintech', 'Berlin, DE', 'Investor', 'Advisor']);
    expect(personFacts(person({ industry: null, location: 'Lisbon', professionalRole: ['A', 'B', 'C', 'D'] })).tags)
      .toEqual(['Lisbon', 'A', 'B', 'C']);
    expect(personFacts(person({ location: '  ' })).tags).toEqual([]);
  });
});

// ── The page ──────────────────────────────────────────────────────────────────────────────────────

describe('Your profile: the page', () => {
  it('/profile is the new page and the old form moved to /profile/edit, ahead of /profile/:userId', () => {
    expect(app()).toMatch(/<Route path="\/profile" element=\{<YourProfilePage \/>\} \/>/);
    expect(app()).toMatch(/<Route path="\/profile\/edit" element=\{<ProfilePage \/>\} \/>/);
    expect(app()).toMatch(/<Route path="\/profile\/:userId" element=\{<PublicProfilePage \/>\} \/>/);
    expect(app().indexOf('path="/profile/edit"')).toBeLessThan(app().indexOf('path="/profile/:userId"'));
  });

  it('the hero is your card from GET /people/me/card, and the private part is your own profile, both refreshed by user:<you>', () => {
    expect(api()).toMatch(/export const fetchMyCard = \(\) => api\.get\('\/people\/me\/card'\)/);
    expect(api()).toMatch(/export const fetchMyProfile = \(\) => api\.get\('\/users\/me'\)/);
    expect(count(page(), /\buseQuery\(/g)).toBe(2);
    expect(count(page(), /meta: \{ entities: me \? \[E\.user\(me\)\] : \[\] \}/g)).toBe(2);
    expect(page()).toMatch(/queryFn: fetchMyCard,/);
    expect(page()).toMatch(/queryFn: fetchMyProfile,/);
    for (const src of [page(), editor()]) expect(src).not.toMatch(/setQueryData|refetchInterval|setInterval/);
  });

  it('opens its columns by the width of the page beside the sidebar, so the name is never cut mid-word at 1024 or 1280', () => {
    const hero = read('features/reason/human/ProfileHero.tsx');
    expect(hero).toMatch(/shell: \{\s*grid: '[^']*md:grid-cols-\[260px_minmax\(0,1fr\)\] md:gap-\[18px\] min-\[1213px\]:grid-cols-\[250px_minmax\(0,1fr\)_290px\] min-\[1432px\]:grid-cols-\[320px_minmax\(0,1fr\)_330px\]',\s*name: 'min-\[1213px\]:max-\[1431px\]:text-\[44px\]',\s*panel: 'min-\[1213px\]:col-span-1',/);
    expect(page()).toMatch(/<HeroFrame\s+fit="shell"/);
    expect(page()).toMatch(/<DarkPanel fit="shell"/);
  });

  it('has the same look as the Human Profile hero: it is drawn by the same frame', () => {
    expect(page()).toMatch(/import \{ DarkPanel, HeroFrame, NoteBox, Offer \} from '\.\.\/human\/ProfileHero';/);
    // What you can bring sits in the very box other members read it in.
    expect(page()).toMatch(/<Offer label="They can bring" text=\{bring\} \/>/);
    expect(page()).toMatch(/<HeroFrame\b/);
    expect(page()).toMatch(/personFacts\(card\.data\)/);
  });

  it('has the section headed "Only you see this", and the two edit links, and the company placeholder', () => {
    expect(count(page(), />Only you see this</g)).toBe(1);
    expect(page()).toMatch(/to=\{EDIT_PROFILE_TO\}/);
    expect(page()).toMatch(/to=\{EDIT_ANSWERS_TO\}/);
    expect(page()).toMatch(/to=\{ADD_COMPANY_TO\}/);
    expect(page()).toMatch(/>Edit profile</);
    expect(page()).toMatch(/>Edit answers</);
    expect(page()).toMatch(/>Add your company</);
  });

  it('shows "Optimize your profile: connect LinkedIn" only when there is no LinkedIn', () => {
    expect(page()).toMatch(/\{needsLinkedin\(card\.data\) && \(/);
    expect(count(page(), /Optimize your profile: connect LinkedIn/g)).toBe(1);
    expect(page()).toMatch(/to=\{CONNECT_LINKEDIN_TO\}/);
  });

  it('has a loading, an error and an empty state', () => {
    expect(page()).toMatch(/aria-busy="true"/);
    expect(page()).toMatch(/We could not load your profile just now\./);
    expect(page()).toMatch(/onClick=\{\(\) => void card\.refetch\(\)\}/);
    expect(page()).toMatch(/row\.value \?\? row\.empty/);
  });

  it('says "event", never "session", and uses neither a failing grey nor red text', () => {
    for (const src of [page(), editor(), banner(), more()]) {
      expect(src).not.toMatch(/\bsessions?\b/i);
      expect(src).not.toMatch(/#7b8190|#8b8f96/i);
      expect(src).not.toMatch(/(?<![\w-])text-reason-red(?!-hover)/);
    }
  });
});

describe('Your profile: the banner', () => {
  it('Change banner crops in the browser, then sends PUT /users/me/banner; Remove asks first, then sends DELETE', () => {
    expect(api()).toMatch(/export const uploadBanner = \(image: string\) => api\.put\('\/users\/me\/banner', \{ image \}\);/);
    expect(api()).toMatch(/export const removeBannerRequest = \(\) => api\.delete\('\/users\/me\/banner'\);/);
    expect(editor()).toMatch(/uploadBanner\(await cropToBanner\(file\)\)/);
    expect(editor()).toMatch(/>\s*\{upload\.isPending \? 'Uploading\.\.\.' : 'Change banner'\}\s*</);
    expect(editor()).toMatch(/title="Remove your banner\?"/);
    expect(editor()).toMatch(/mutationFn: removeBannerRequest/);
    // The file is checked before it is read, and the same file can be chosen again after a failure.
    expect(editor()).toMatch(/bannerFileProblem\(file\)/);
    expect(editor()).toMatch(/input\.value = '';/);
    expect(editor()).toMatch(/accept="image\/jpeg,image\/png,image\/webp"/);
  });

  it('after a change it refreshes your card and your profile, and keeps its button busy until they are in', () => {
    expect(count(editor(), /return qc\.invalidateQueries\(\{ queryKey: reasonKeys\.mine \}\);/g)).toBe(2);
    expect(editor()).toMatch(/networkMode: 'always'/);
    expect(editor()).toMatch(/addToast\(errorMessage\(err, /);
  });

  it('a picture that fails to load draws the default banner, the way a failed photo draws initials', () => {
    expect(banner()).toMatch(/const \[failedSrc, setFailedSrc\] = useState<string \| null>\(null\);/);
    expect(banner()).toMatch(/onError=\{\(\) => setFailedSrc\(src\)\}/);
    expect(banner()).toMatch(/bg-gradient-to-r from-\[#1a1a2e\] via-\[#3a1f3d\] to-reason-red/);
    expect(banner()).toMatch(/aspect-\[3\/1\]/);
  });

  it('the Human Profile draws the person\'s banner, and your page draws yours, with the same component', () => {
    expect(human()).toMatch(/<ProfileBanner src=\{brief\.person\.bannerUrl\} \/>/);
    expect(editor()).toMatch(/<ProfileBanner src=\{bannerUrl\}>/);
  });
});

// ── The Human Profile's More menu ──────────────────────────────────────────────────────────────────

describe('Human Profile: More, with Block and Report this member', () => {
  it('sits in the header while a profile is on screen', () => {
    expect(human()).toMatch(/<ProfileMoreMenu\b/);
    expect(more()).toMatch(/aria-expanded=\{open\}/);
    expect(more()).toMatch(/aria-label="More"/);
    expect(more()).toMatch(/>Block</);
    expect(more()).toMatch(/>Report this member</);
  });

  it('Block uses the old public profile\'s confirmation and its call', () => {
    expect(human()).toMatch(/confirm\(`Block \$\{[^}]+\}\? They won't be able to message you and you won't be matched together in future events\.`\)/);
    expect(api()).toMatch(/export const blockMember = \(userId: string\) => api\.post\(`\/users\/\$\{memberSegment\(userId\)\}\/block`\);/);
    expect(human()).toMatch(/mutationFn: \(\) => blockMember\(userId\)/);
  });

  it('Report opens the old public profile\'s report dialog, and the move bar steps aside while it is open', () => {
    expect(human()).toMatch(/<ReportUserModal\b/);
    expect(human()).toMatch(/\{!hideBar && \(/);
    expect(human()).toMatch(/hideBar=\{reportOpen\}/);
  });

  it('"also block" in the report dialog leaves the profile once, and is cleared for the next profile the page shows', () => {
    expect(human()).toMatch(/onBlocked=\{\(\) => setBlockedInReport\(true\)\}/);
    expect(human()).toMatch(/const closeReport = \(\) => \{\s*setReportOpen\(false\);\s*setBlockedInReport\(false\);\s*if \(blockedInReport\) leaveBlocked\(\);\s*\};/);
  });

  it('the brief also listens for blocks, so a block in either direction takes the profile away without a refresh', () => {
    expect(human()).toMatch(/entities: me && userId \? \[E\.user\(me\), E\.user\(userId\), E\.userInvites\(me\), E\.userDms\(me\), E\.userBlocks\(me\)\] : \[\]/);
  });

  it('closes on Escape or a tap outside it, like the account menu', () => {
    expect(more()).toMatch(/e\.key !== 'Escape'/);
    expect(more()).toMatch(/addEventListener\('pointerdown', onOutside\)/);
  });
});

// ── The old form, at /profile/edit ─────────────────────────────────────────────────────────────────

describe('the old form at /profile/edit', () => {
  it('has a way back to your profile', () => {
    expect(form()).toMatch(/<Link to="\/profile"[^>]*>[\s\S]*?Back to your profile[\s\S]*?<\/Link>/);
  });

  it('has the LinkedIn field the LinkedIn card links to, and takes you to it', () => {
    expect(form()).toMatch(/id="linkedin"/);
    expect(form()).toMatch(/hash === '#linkedin'/);
    expect(form()).toMatch(/scrollIntoView\(/);
  });

  it('the Google photo comes back to the form, where its outcome is read', () => {
    expect(form()).toMatch(/api\.post\('\/auth\/google\/photo-state', \{ redirect: '\/profile\/edit' \}\)/);
  });
});
