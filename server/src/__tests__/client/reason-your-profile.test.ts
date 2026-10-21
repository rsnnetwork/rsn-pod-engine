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
import { canBring, type PersonBrief } from '@rsn/shared';
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

  // Fix round 1: the box says "this is what members read", so it must be what the brief gives them, not the raw text.
  it('is cut at 160 characters, as the brief cuts it: 161 become 159 and an ellipsis', () => {
    expect(youCanBring({ whatICanHelpWith: 'a'.repeat(161), expertiseText: 'pricing' })).toBe(`${'a'.repeat(159)}…`);
    expect(youCanBring({ whatICanHelpWith: 'a'.repeat(160), expertiseText: null })).toBe('a'.repeat(160));
  });

  it('treats an offer with no letter or digit as none, as the brief does, and shows the expertise instead', () => {
    expect(youCanBring({ whatICanHelpWith: '.', expertiseText: ' pricing ' })).toBe('pricing');
    expect(youCanBring({ whatICanHelpWith: '…', expertiseText: '!!' })).toBeNull();
    expect(youCanBring({ whatICanHelpWith: '.', expertiseText: null })).toBeNull();
  });

  it('is the very rule the brief uses (canBring, in @rsn/shared), not a copy of it', () => {
    expect(read('features/reason/profile/your-profile-text.ts')).toMatch(/import \{ canBring, type PublicMember, type User \} from '@rsn\/shared';/);
    expect(read('features/reason/profile/your-profile-text.ts')).toMatch(/return canBring\(card\);/);
    for (const card of [
      { whatICanHelpWith: 'Intros', expertiseText: 'x' }, { whatICanHelpWith: ' . ', expertiseText: 'b'.repeat(200) },
      { whatICanHelpWith: '🙂', expertiseText: '42' }, { whatICanHelpWith: null, expertiseText: '   ' },
    ]) expect(youCanBring(card)).toBe(canBring(card));
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

  // Final review (C2): "Edit answers" opened the first question alone, a dead end. It opens screen 7, with every
  // answer's [Edit].
  it('every link goes where the brief says, and Edit answers opens every answer, on screen 7', () => {
    expect([EDIT_PROFILE_TO, EDIT_ANSWERS_TO, ADD_COMPANY_TO, CONNECT_LINKEDIN_TO])
      .toEqual(['/profile/edit', '/onboarding?edit=profile', '/entities?create=1', '/profile/edit#linkedin']);
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

  it('has the section headed "Only you see this", the two edit links, and your entities with "Add your company"', () => {
    expect(count(page(), />Only you see this</g)).toBe(1);
    expect(page()).toMatch(/to=\{EDIT_PROFILE_TO\}/);
    expect(page()).toMatch(/to=\{EDIT_ANSWERS_TO\}/);
    expect(page()).toMatch(/>Edit profile</);
    expect(page()).toMatch(/>Edit answers</);
    // Task 11 (item 5): the company placeholder is your entities now, with the same link (pinned in reason-entities-pages).
    expect(page()).toMatch(/<ProfileEntities \/>/);
    const entities = read('features/reason/entities/ProfileEntities.tsx');
    expect(entities).toMatch(/to=\{ADD_COMPANY_TO\}/);
    expect(entities).toMatch(/>Add your company</);
  });

  it('shows "Optimize your profile: connect LinkedIn" only when there is no LinkedIn', () => {
    expect(page()).toMatch(/\{needsLinkedin\(card\.data\) && \(/);
    expect(count(page(), /Optimize your profile: connect LinkedIn/g)).toBe(1);
    expect(page()).toMatch(/to=\{CONNECT_LINKEDIN_TO\}/);
  });

  it('side by side, the company card and "Only you see this" keep their own heights: no blank card beside the answers', () => {
    expect(page()).toMatch(/min-\[981px\]:grid-cols-2 min-\[981px\]:items-start/);
  });

  it('has a loading, an error and an empty state', () => {
    expect(page()).toMatch(/aria-busy="true"/);
    expect(page()).toMatch(/We could not load your profile just now\./);
    expect(page()).toMatch(/onClick=\{\(\) => void card\.refetch\(\)\}/);
    expect(page()).toMatch(/row\.value \?\? row\.empty/);
  });

  it('says "event", never "session", and uses neither a failing grey nor red text', () => {
    for (const src of [page(), editor(), banner(), more(), read('features/reason/human/useBlockedByYou.ts')]) {
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
    expect(human()).toMatch(/entities: me && userId \? \[E\.user\(me\), E\.user\(userId\), E\.userInvites\(me\), E\.userDms\(me\), E\.userBlocks\(me\), E\.userEntities\(userId\), E\.userEntities\(me\)\] : \[\]/);
  });

  // Fix round 1: a profile you blocked is a 404, so Unblock cannot live on the profile or in More. Without it on the
  // notice, a block could not be undone once every people link opens the Human Profile.
  it('a profile YOU blocked says so on its notice and offers Unblock, asking first; the plain notice stays for anyone else', () => {
    const hook = read('features/reason/human/useBlockedByYou.ts');
    expect(human()).toMatch(/const blocked = useBlockedByYou\(userId, me, view === 'unavailable' && validId\);/);
    expect(human()).toMatch(/view === 'unavailable' && blocked\.blockedByYou \? \(\s*<Notice title="You blocked this member\."/);
    expect(human()).toMatch(/onClick=\{blocked\.askToUnblock\}/);
    expect(human()).toMatch(/\{blocked\.unblocking \? 'Unblocking\.\.\.' : 'Unblock'\}/);
    expect(count(human(), /This profile is not available\./g)).toBe(1);
    // The skeleton stays while the answer is on its way, so the plain notice never flashes first.
    expect(human()).toMatch(/view === 'loading' \|\| \(view === 'unavailable' && blocked\.checking\)/);
    // Asked only about a member id, only while "not available" is on screen, and refreshed by any block or unblock.
    expect(hook).toMatch(/queryFn: \(\) => fetchBlockStatus\(userId\),\s*enabled: asking && !!me,/);
    expect(hook).toMatch(/meta: \{ entities: me \? \[E\.userBlocks\(me\)\] : \[\] \}/);
    expect(hook).toMatch(/blockedByYou: status\.data\?\.hasBlocked === true/);
    // The old profile unblocked at once; now a question comes first, in the dialog Block uses.
    expect(hook).toMatch(/UNBLOCK_QUESTION = 'Unblock this member\? They will be able to message you again, and you may be matched together in future events\.';/);
    expect(hook).toMatch(/if \(confirm\(UNBLOCK_QUESTION\)\) unblock\.mutate\(\);/);
    expect(hook).toMatch(/mutationFn: \(\) => unblockMember\(userId\)/);
    // The refresh is returned, so Unblock stays busy until the brief is back and the profile is on screen.
    expect(hook).toMatch(/return qc\.invalidateQueries\(\{ queryKey: reasonKeys\.all \}\);/);
    expect(hook).toMatch(/onError: \(err\) => addToast\(errorMessage\(err, /);
    expect(api()).toMatch(/export const unblockMember = \(userId: string\) => api\.delete\(`\/users\/\$\{memberSegment\(userId\)\}\/block`\);/);
    expect(api()).toMatch(/api\.get\(`\/users\/\$\{memberSegment\(userId\)\}\/block-status`\)/);
  });

  it('keeps the promise Messages makes when you block someone ("You can unblock them from their profile.")', () => {
    expect(read('features/messages/MessagesPage.tsx')).toMatch(/You can unblock them from their profile\./);
    expect(human()).toMatch(/<Notice title="You blocked this member\."[\s\S]*?'Unblock'/);
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

  // Final review (C2): the next save of the answers writes over these three, and no search ever reads them, so a change
  // made here was lost. They are shown as they are, with the way to the answers.
  const ANSWER_FIELDS = ['whatICanHelpWith', 'whoIWantToMeet', 'myIntent'];
  it('"What I can help with", "Who I want to meet" and "My intent" are shown, not edited, with Edit answers beside them', () => {
    for (const field of ANSWER_FIELDS) {
      expect(form()).not.toMatch(new RegExp(`register\\('${field}'\\)`));
      expect(form()).toMatch(new RegExp(`value: visibleText\\(user\\.${field}\\) \\}`));
    }
    for (const label of ['What I can help with', 'Who I want to meet', 'My intent']) expect(form()).toContain(`label: '${label}'`);
    expect(form()).toMatch(/import \{ EDIT_ANSWERS_TO \} from '@\/features\/reason\/profile\/your-profile-text';/);
    expect(form()).toMatch(/<Link to=\{EDIT_ANSWERS_TO\} className="[^"]*\bmin-h-\[44px\][^"]*">Edit answers<\/Link>/);
    expect(form()).toMatch(/\{value \?\? 'Not answered yet\.'\}/);
    // The two that only this form writes stay editable.
    for (const field of ['whatICareAbout', 'whyIWantToMeet']) expect(form()).toMatch(new RegExp(`register\\('${field}'\\)`));
  });

  it('a save on the form never sends those three, so it never writes over the answers', () => {
    const submit = form().slice(form().indexOf('const onSubmit = async'), form().indexOf('if (!user) return null;'));
    expect(submit).toMatch(/api\.put\('\/users\/me', \{/);
    for (const field of ANSWER_FIELDS) expect(submit).not.toContain(field);
    const fields = form().slice(form().indexOf('interface ProfileForm {'), form().indexOf('}', form().indexOf('interface ProfileForm {')));
    for (const field of ANSWER_FIELDS) expect(fields).not.toContain(field);
  });
});
