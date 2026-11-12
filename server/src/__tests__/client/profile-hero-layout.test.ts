// server/src/__tests__/client/profile-hero-layout.test.ts
// Stefan, 10 Nov 2026: "if there is no banner, it shouldn't be there? there is A LOT of space not being used on that
// page. The profile picture should be top centered too? There should also be website next to linkedin link, and perhaps
// other social media too?" The markup is read from the source (it needs a browser); what the hero draws for the links is
// rendered here with its pictures standing in, and the rules for the links and the form's boxes are run for real.
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as text from '../../../../client/src/features/reason/human/profile-text';
import { SOCIAL_FIELDS, socialSave } from '../../../../client/src/features/profile/social-links-box';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const hero = () => read('features/reason/human/ProfileHero.tsx');
const human = () => read('features/reason/human/HumanProfilePage.tsx');
const editor = () => read('features/reason/profile/BannerEditor.tsx');
const yours = () => read('features/reason/profile/YourProfilePage.tsx');
const form = () => read('features/profile/ProfilePage.tsx');

describe('no empty banner', () => {
  it('another member\'s profile draws no banner element at all when they have none', () => {
    expect(human()).toMatch(/\{brief\.person\.bannerUrl && \(\s*<div className="mb-\[11px\] md:mb-\[18px\]">\s*<ProfileBanner src=\{brief\.person\.bannerUrl\} \/>\s*<\/div>\s*\)\}/);
    expect((human().match(/<ProfileBanner/g) ?? []).length).toBe(1);
  });

  it('your own profile swaps the empty strip for a slim "Add banner" button that opens the banner editor (Shirley pilot S6, RSN 13)', () => {
    expect(editor()).toMatch(/\{bannerUrl \? \(/);
    expect(editor()).toMatch(/<ProfileBanner src=\{bannerUrl\}>/);
    expect(editor()).toMatch(/onClick=\{banner\.edit\}[^>]*className="flex min-h-\[44px\] w-full[^"]*"[^>]*>\s*<ImagePlus[^>]*\/> Add banner/);
    expect(editor()).toMatch(/<PictureEditor \{\.\.\.banner\.editor\} \/>/);
  });

  it('the hero is told whether a banner is above it, on both profiles', () => {
    expect(hero()).toMatch(/hasBanner=\{!!brief\.person\.bannerUrl\}/);
    expect(yours()).toMatch(/hasBanner=\{!!card\.data\.bannerUrl\}/);
  });

  it('the entity banner keeps its own gradient fallback (only the member profile changed)', () => {
    expect(read('features/reason/human/ProfileBanner.tsx')).toMatch(/bg-gradient-to-r from-\[#1a1a2e\] via-\[#3a1f3d\] to-reason-red/);
  });
});

describe('the photo is centred at the top at every width', () => {
  it('the card is a centred column, with the photo first, round, in one size set', () => {
    expect(hero()).toMatch(/<section className="flex min-w-0 flex-col items-center [^"]*text-center[^"]*">/);
    const card = hero().slice(hero().indexOf('export function HeroFrame'));
    expect(card.indexOf('data-testid="profile-photo"')).toBeGreaterThan(-1);
    expect(card.indexOf('data-testid="profile-photo"')).toBeLessThan(card.indexOf('<h1'));
    expect(card).toMatch(/<Avatar src=\{photo\} name=\{who\.name\} size="2xl" className="h-28 w-28 [^"]*md:h-36 md:w-36/);
  });

  it('there is no side tile any more: the grid is the card and the panel, and no breakpoint gives the photo a column', () => {
    expect(hero()).not.toMatch(/\[320px_|\[250px_|\[260px_|h-\[43vh\]|min-h-\[430px\]|isSmallPhoto/);
    expect(hero()).toMatch(/min-\[981px\]:grid-cols-\[minmax\(0,1fr\)_330px\] min-\[1200px\]:grid-cols-\[minmax\(0,1fr\)_380px\]/);
    expect(hero()).toMatch(/min-\[1213px\]:grid-cols-\[minmax\(0,1fr\)_330px\] min-\[1432px\]:grid-cols-\[minmax\(0,1fr\)_380px\]/);
    expect(hero()).not.toMatch(/md:col-span-2/);
  });

  it('with a banner the photo is pulled up over its lower edge, centred; without one it is not', () => {
    expect(hero()).toMatch(/const OVERLAP = '-mt-\[85px\] md:-mt-\[118px\]';/);
    expect(hero()).toMatch(/cn\('relative shrink-0 rounded-full', hasBanner && OVERLAP\)/);
    expect(hero()).toMatch(/hasBanner = false/);
  });

  it('the pencil sits on the photo\'s corner, and the banner\'s buttons moved to its top so the photo never covers them', () => {
    expect(hero()).toMatch(/\{photoAction && <div className="absolute -bottom-1 -right-3">\{photoAction\}<\/div>\}/);
    expect(editor()).toMatch(/absolute right-2 top-2 flex items-center gap-2 md:right-3 md:top-3/);
    expect(editor()).not.toMatch(/absolute bottom-2 right-2/);
  });

  it('name, role, links, actions and tags are centred', () => {
    expect(read('features/reason/human/ProfileHeroActions.tsx')).toMatch(/mt-3 flex flex-wrap justify-center gap-2/);
    expect(hero()).toMatch(/flex flex-wrap justify-center gap-1\.5/);
    expect(hero()).toMatch(/data-testid="profile-links">/);
    expect(hero()).toMatch(/mt-2 flex flex-wrap justify-center gap-2/);
  });
});

describe('the links row', () => {
  const person = (over: Record<string, unknown> = {}) => ({
    id: '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03', displayName: 'Nora None', firstName: 'Nora', lastName: 'None', avatarUrl: null, bannerUrl: null,
    bio: 'Backs founders.', company: 'Northwind', jobTitle: 'Partner', industry: null, location: null, linkedinUrl: null,
    websiteUrl: null, instagramUrl: null, xUrl: null, facebookUrl: null, languages: [], professionalRole: [], expertiseText: null, whatICanHelpWith: null, ...over,
  });

  it('lists LinkedIn, Website, Instagram, X and Facebook in that order, only those supplied', () => {
    const all = text.profileLinks(person({
      linkedinUrl: 'https://www.linkedin.com/in/nora', websiteUrl: 'https://nora.example', instagramUrl: 'https://instagram.com/nora', xUrl: 'https://x.com/nora', facebookUrl: 'https://facebook.com/nora',
    }));
    expect(all.map((l) => l.label)).toEqual(['LinkedIn', 'Website', 'Instagram', 'X', 'Facebook']);
    expect(text.profileLinks(person({ xUrl: 'https://x.com/nora', websiteUrl: 'https://nora.example' })).map((l) => l.label)).toEqual(['Website', 'X']);
    expect(text.profileLinks(person())).toEqual([]);
  });

  it('a stored address that is not safe or not on the right site is no button', () => {
    expect(text.profileLinks(person({ websiteUrl: 'javascript:alert(1)', instagramUrl: 'https://evil.com/instagram.com', xUrl: 'junk', facebookUrl: '   ' }))).toEqual([]);
  });

  it('is drawn as icon + label buttons, each 44px tall, opening a new tab with no opener, and only the ones supplied', () => {
    const icons = new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : () => null) });
    const { outputText } = ts.transpileModule(fs.readFileSync(path.join(CLIENT, 'features/reason/human/ProfileHero.tsx'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    const stand: Record<string, unknown> = {
      'lucide-react': icons,
      '@/components/ui/Avatar': { __esModule: true, default: () => null },
      '@/features/calls/ProfileCallButton': { __esModule: true, default: () => null },
      '@/lib/utils': { cn: (...p: unknown[]) => p.filter(Boolean).join(' ') },
      '../brand/ReasonSheep': { __esModule: true, default: () => null },
      '../person': require('../../../../client/src/features/reason/person'),
      './profile-text': text,
      './ProfileHeroActions': { __esModule: true, default: () => null },
    };
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', 'require', outputText)(mod, mod.exports, (id: string) => (id in stand ? stand[id] : require(id)));
    const Frame = mod.exports.HeroFrame as (p: Record<string, unknown>) => ReactElement;
    const html = renderToStaticMarkup(createElement(Frame as never, {
      photo: null, kicker: 'The human', note: null, panel: null,
      who: text.personFacts(person({ websiteUrl: 'https://nora.example', facebookUrl: 'https://facebook.com/nora' })),
    }));
    const links = html.match(/<a [^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('href="https://nora.example"');
    expect(links[1]).toContain('href="https://facebook.com/nora"');
    for (const link of links) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
      expect(link).toMatch(/class="[^"]*\bmin-h-\[44px\][^"]*"/);
    }
    expect(links.map((l) => l.replace(/<[^>]*>/g, ''))).toEqual(['Website (opens in a new tab)', 'Facebook (opens in a new tab)']);
    expect(html.indexOf('Partner · Northwind')).toBeLessThan(html.indexOf('<a '));
    expect(html.indexOf('<a ')).toBeLessThan(html.indexOf('Backs founders.'));
    expect(html).not.toContain('Instagram');
  });
});

describe('the edit form', () => {
  it('has a box for each link, checked and sent only when changed, a wrong one said under its own field', () => {
    expect(SOCIAL_FIELDS.map((s) => s.field)).toEqual(['websiteUrl', 'instagramUrl', 'xUrl', 'facebookUrl']);
    expect(form()).toMatch(/\{SOCIAL_FIELDS\.map\(\(spec\) => \(\s*<Input[\s\S]*?error=\{errors\[spec\.field\]\?\.message\}[\s\S]*?\{\.\.\.register\(spec\.field\)\}/);
    expect(form()).toMatch(/const save = socialSave\(spec, typedSocial\[spec\.field\], !!dirtyFields\[spec\.field\]\);/);
    expect(form()).toMatch(/setError\(spec\.field, \{ message: save\.message \}/);
    expect(form()).toMatch(/\.\.\.socialBody,/);
    expect(form()).toMatch(/const \{ linkedinUrl: typedLinkedin, websiteUrl, instagramUrl, xUrl, facebookUrl, \.\.\.fields \} = data;/);
  });

  it('an untouched box is kept, a typed one is stored, an emptied one clears, a wrong one is refused with its sentence', () => {
    const [website, instagram] = SOCIAL_FIELDS;
    expect(socialSave(website, 'whatever', false)).toEqual({ kind: 'keep' });
    expect(socialSave(website, 'example.com', true)).toEqual({ kind: 'send', url: 'https://example.com' });
    expect(socialSave(website, '  ', true)).toEqual({ kind: 'send', url: null });
    expect(socialSave(website, 'javascript:alert(1)', true)).toEqual({ kind: 'refuse', message: 'Enter a web address, for example example.com' });
    expect(socialSave(instagram, 'evil.com/instagram.com', true)).toEqual({ kind: 'refuse', message: 'Enter your Instagram link, for example instagram.com/your-name' });
  });

  it('the LinkedIn box and its photo offer are untouched', () => {
    expect(form()).toMatch(/id="linkedin"/);
    expect(form()).toMatch(/const linkedin = linkedinSave\(typedLinkedin, !!dirtyFields\.linkedinUrl\);/);
    expect(form()).toMatch(/useLinkedinPhoto\(\)/);
  });
});
