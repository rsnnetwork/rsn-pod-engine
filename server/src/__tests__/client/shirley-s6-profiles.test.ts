// server/src/__tests__/client/shirley-s6-profiles.test.ts
// Shirley pilot S6 (RSN 12, RSN 13): profiles people can preview and share. The pure rules (the links, what the
// screens say, the banner hints) are run; the markup and wiring need a browser, so they are read from the source like
// the other client tests. e2e/tests/shirley-s6-profiles.spec.ts presses everything for real against production.
import * as fs from 'fs';
import * as path from 'path';
import { PICTURE_SHAPES } from '@rsn/shared';
import { PREVIEW_TO, SHARE_WORDS, memberLinkFor, publicLinkFor } from '../../../../client/src/features/reason/profile/share-text';
import { bannerHints } from '../../../../client/src/components/picture/picture-file';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string) => read(rel).replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const menu = () => code('features/reason/shell/AccountMenu.tsx');
const topbar = () => code('features/reason/shell/ShellTopbar.tsx');
const yours = () => code('features/reason/profile/YourProfilePage.tsx');
const share = () => code('features/reason/profile/ShareProfileCard.tsx');
const preview = () => code('features/reason/profile/ProfilePreviewPage.tsx');
const shared = () => code('features/reason/profile/SharedProfilePage.tsx');
const card = () => code('features/reason/profile/PublicCardView.tsx');
const app = () => read('App.tsx');

describe('the two links', () => {
  it('the member link is the Human Profile address; the public link is the server\'s path on this origin', () => {
    expect(memberLinkFor('https://app.rsn.network', '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03'))
      .toBe('https://app.rsn.network/people/3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03');
    expect(publicLinkFor('https://app.rsn.network', '/p/AbCdEfGhIjKlMnOpQrStUv')).toBe('https://app.rsn.network/p/AbCdEfGhIjKlMnOpQrStUv');
    expect(PREVIEW_TO).toBe('/profile/preview');
  });

  it('the consent line says who can see the public link and what it never shows', () => {
    expect(SHARE_WORDS.consent).toMatch(/even people who are not on REASON/);
    expect(SHARE_WORDS.consent).toMatch(/never shows your answers, your email, your communities or a way to contact you/);
    expect(SHARE_WORDS.consent).toMatch(/Turn it off or make a new link at any time/);
    for (const words of Object.values(SHARE_WORDS)) expect(words).not.toMatch(/\bsessions?\b|token|\bid\b/i);
  });
});

describe('the banner (RSN 13)', () => {
  it('the editor gives the server\'s own size and warns that wide screens crop the top and bottom', () => {
    const hints = bannerHints(PICTURE_SHAPES.banner.width, PICTURE_SHAPES.banner.height);
    expect(hints.size).toBe('Recommended size: 2400 × 800 px (3:1).');
    expect(hints.crop).toMatch(/^Wide screens crop the top and bottom of your banner/);
    const editor = code('components/picture/PictureEditor.tsx');
    expect(editor).toMatch(/const BANNER_HINTS = bannerHints\(PICTURE_SHAPES\.banner\.width, PICTURE_SHAPES\.banner\.height\);/);
    expect(editor).toMatch(/\{aspect === 3 && \(\s*<div[^>]*data-testid="banner-hints">\s*<p>\{BANNER_HINTS\.size\}<\/p>\s*<p role="note"[^>]*>\{BANNER_HINTS\.crop\}<\/p>/);
  });

  it('the control says "Add banner", the pencil "Change banner"; the dead 1500 by 500 helpers are gone', () => {
    const banner = code('features/reason/profile/BannerEditor.tsx');
    expect(banner).toMatch(/\/> Add banner\n/);
    expect(banner).toMatch(/<PencilButton label="Change banner"/);
    expect(banner).not.toMatch(/cover image/);
    expect(fs.existsSync(path.join(CLIENT, 'features/reason/profile/banner-image.ts'))).toBe(false);
    expect(fs.existsSync(path.join(CLIENT, 'features/reason/profile/crop-banner.ts'))).toBe(false);
  });
});

describe('the photo (RSN 13)', () => {
  it('on Your profile the big photo itself opens the photo editor, named for what it does', () => {
    expect(yours()).toMatch(/onPhotoClick=\{photo\.busy \? undefined : photo\.edit\}/);
    expect(yours()).toMatch(/photoLabel="Change your photo"/);
    const hero = code('features/reason/human/ProfileHero.tsx');
    expect(hero).toMatch(/\{onPhotoClick \? \(\s*<button\s+type="button"\s+onClick=\{onPhotoClick\}\s+aria-label=\{photoLabel\}/);
    // Another member's profile passes no handler, so their photo is only a picture.
    expect(code('features/reason/human/ProfileHero.tsx').match(/onPhotoClick=/g) ?? []).toHaveLength(0);
  });

  it('the top bar\'s photo opens the account menu instead of linking to the page you may be on', () => {
    expect(topbar()).toMatch(/<AccountMenu \/>/);
    expect(topbar()).not.toMatch(/to="\/profile"/);
  });

  it('the account menu has the six rows, in order, each at least 44px', () => {
    const rows = [...menu().matchAll(/className=\{(?:ROW|cn\(ROW[^}]*\))\}[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    expect(rows).toEqual(['View profile', 'Preview as others see it', 'Copy link', 'Edit profile', 'Settings', 'Log out']);
    expect(menu()).toMatch(/const ROW = 'flex min-h-\[44px\] w-full/);
    expect(menu()).toMatch(/className=\{cn\('grid h-11 w-11/);
  });

  it('is portalled to <body>, kept inside a 360px window, and answers the keyboard', () => {
    expect(menu()).toMatch(/createPortal\(/);
    expect(menu()).toMatch(/document\.body,\n\s*\)\}/);
    expect(menu()).toMatch(/w-\[min\(280px,calc\(100vw-16px\)\)\]/);
    expect(menu()).toMatch(/right: Math\.max\(EDGE, window\.innerWidth - box\.right\)/);
    expect(menu()).toMatch(/aria-expanded=\{open\}/);
    expect(menu()).toMatch(/if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*close\(true\);/);
    expect(menu()).toMatch(/if \(e\.key !== 'Tab'\) return;/);
    expect(menu()).toMatch(/document\.addEventListener\('pointerdown', onOutside\)/);
    // Log out asks first, through the app's own sheet.
    expect(menu()).toMatch(/<LogoutSheet open=\{confirm\}/);
  });
});

describe('sharing (RSN 12)', () => {
  it('Your profile offers the preview and the share card', () => {
    expect(yours()).toMatch(/<Link to=\{PREVIEW_TO\}[^>]*>Preview as others see it<\/Link>/);
    expect(yours()).toMatch(/<ShareProfileCard \/>/);
  });

  it('the share card follows user:<you>, and asks before turning the link off or replacing it', () => {
    expect(share()).toMatch(/queryKey: reasonKeys\.myPublicLink,\s*queryFn: fetchPublicLink,\s*enabled: !!me,\s*meta: \{ entities: me \? \[E\.user\(me\)\] : \[\] \},/);
    expect(share()).toMatch(/if \(m === 'revoke' && !\(await ask\(\{ title: SHARE_WORDS\.revokeTitle[^)]*tone: 'danger' \}\)\)\) return;/);
    expect(share()).toMatch(/if \(m === 'remake' && !\(await ask\(\{ title: SHARE_WORDS\.remakeTitle[^)]*tone: 'danger' \}\)\)\) return;/);
    expect(share()).toMatch(/if \(busy\) return;/);
    expect(share()).toMatch(/\{confirmDialog\}/);
    // A loading, an error and an off state, and the paused notice while hidden from search.
    expect(share()).toMatch(/state\.isPending \?/);
    expect(share()).toMatch(/state\.isError \?/);
    expect(share()).toMatch(/state\.data\?\.paused === 'hidden'/);
    expect(share()).toMatch(/'Make a public link'/);
  });

  it('the preview is the server\'s brief for a member with no connection, drawn by the Human Profile\'s own parts', () => {
    expect(preview()).toMatch(/queryFn: fetchMyPreview,/);
    expect(preview()).toMatch(/meta: \{ entities: me \? \[E\.user\(me\), E\.userEntities\(me\)\] : \[\] \}/);
    expect(preview()).toMatch(/<ProfileHero brief=\{preview\.data\}/);
    expect(preview()).toMatch(/<ProfileDetails brief=\{preview\.data\}/);
    // The member's bar is shown, and in the preview its buttons send nothing.
    expect(preview()).toMatch(/<MoveBar brief=\{preview\.data\} busy=\{false\} onPrimary=\{inPreview\} onToggleSave=\{inPreview\} onToggleRemove=\{inPreview\} \/>/);
    expect(preview()).not.toMatch(/setPersonResponse|sendMeetRequest|blockMember/);
    expect(code('features/reason/api.ts')).toMatch(/export const fetchMyPreview = \(\) => api\.get\('\/people\/me\/preview'\)/);
  });

  it('the public link page shows the public card only: no entities, communities, or way to contact the member', () => {
    for (const src of [card(), shared()]) {
      expect(src).not.toMatch(/ProfileDetails|EntityRows|ProfileHeroActions|ProfileCallButton|MoveBar|MeetSheet|\/messages|circles|pods/);
    }
    expect(card()).toMatch(/<HeroFrame\b/);
    expect(shared()).toMatch(/document\.createElement\('meta'\)/);
    expect(shared()).toMatch(/tag\.content = 'noindex, nofollow';/);
    expect(shared()).toMatch(/This profile link is not available\./);
    expect(read('features/reason/profile/SharedProfilePage.tsx')).toMatch(/\/\/ realtime: skip — signed-out public page, nothing to follow\n\s*const profile = useQuery\(/);
  });

  it('/p/:token is open signed out; /profile/preview needs sign-in', () => {
    expect(app()).toMatch(/<Route path="\/p\/:token" element=\{<><SharedProfilePage \/><ToastContainer \/><\/>\} \/>/);
    expect(app()).toMatch(/<Route path="\/profile\/preview" element=\{<ProtectedRoute><><ProfilePreviewPage \/><ToastContainer \/><\/><\/ProtectedRoute>\} \/>/);
  });
});

describe('copying a link', () => {
  it('falls back to a selected text box, then to the phone\'s share sheet, and only then says it could not copy', () => {
    const copy = code('lib/copy-text.ts');
    expect(copy).toMatch(/await navigator\.clipboard\.writeText\(text\);/);
    expect(copy).toMatch(/return document\.execCommand\('copy'\);/);
    const hook = code('features/reason/profile/useCopyLink.ts');
    expect(hook).toMatch(/if \(await copyText\(url\)\) \{\s*addToast\(copied, 'success'\);/);
    expect(hook).toMatch(/await navigator\.share\(\{ url \}\);/);
    expect(hook).toMatch(/addToast\(SHARE_WORDS\.copyFailed, 'error'\);/);
  });
});
