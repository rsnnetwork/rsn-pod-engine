// ─── Shirley pilot S7 (11 Nov 2026): the screens for entity services, the organiser export and search help ──────────
// Brief RSN 15, items 20 and 21; plan decision D6. The pure rules run here (entity-services-form.ts, space-export.ts,
// searches-help.ts); the screens are pinned by what they must hold: who sees each control, no person's profile carrying
// services, 44px taps, sheets through the portalled Sheet, every query on its entity tags, and one word, "searches".

import * as fs from 'fs';
import * as path from 'path';
import { ENTITY_SERVICE_CATEGORIES } from '@rsn/shared';
import {
  checkedCategories, descriptionField, onField, servicesBody, servicesDefaults, servicesFieldErrors, servicesSchema,
  websiteField, websiteProblem,
} from '../../../../client/src/features/reason/entities/entity-services-form';
import {
  downloadFailedLine, exportFileName, mayExportCircle, mayExportPod, refusalMessage,
} from '../../../../client/src/features/spaces/space-export';
import { searchesHelp } from '../../../../client/src/features/search/searches-help';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** The source without its comments, so a word in a comment is not read as something a member sees. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('services: the editor\'s rules (entity-services-form.ts)', () => {
  const blank = servicesDefaults([]);
  const tick = (over: Record<string, string | boolean>) => ({ ...blank, ...over });

  it('opens with the entity\'s services ticked and their words, every other category empty', () => {
    const v = servicesDefaults([{ category: 'coaching', description: 'For founders', website: 'https://acme.com' }]);
    expect(v[onField('coaching')]).toBe(true);
    expect(v[descriptionField('coaching')]).toBe('For founders');
    expect(v[onField('legal')]).toBe(false);
    expect(Object.keys(v)).toHaveLength(ENTITY_SERVICE_CATEGORIES.length * 3);
  });

  it('sends the ticked ones in the list\'s order, trimmed, blank as null; unticked words are never sent', () => {
    const v = tick({
      [onField('events')]: true, [descriptionField('events')]: '  Monthly salons ', [websiteField('events')]: '',
      [onField('coaching')]: true, [descriptionField('legal')]: 'not ticked', [websiteField('legal')]: 'javascript:alert(1)',
    });
    expect(checkedCategories(v)).toEqual(['coaching', 'events']);
    expect(servicesBody(v)).toEqual({ services: [
      { category: 'coaching', description: null, website: null },
      { category: 'events', description: 'Monthly salons', website: null },
    ] });
    // The unticked javascript: address does not block the save: it is never sent.
    expect(servicesSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    ['javascript:alert(1)'], ['JAVASCRIPT:alert(1)'], ['http://acme.com'], ['data:text/html,x'], ['acme .com'], ['mailto:a@b.co'],
  ])('a ticked service with website %s is refused next to its field', (website) => {
    const r = servicesSchema.safeParse(tick({ [onField('legal')]: true, [websiteField('legal')]: website }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual([websiteField('legal')]);
    expect(websiteProblem(website)).toMatch(/https:\/\//);
  });

  it.each([['acme.com'], ['https://acme.com/x'], ['']])('a website of "%s" is fine to send (the server makes a bare one https)', (w) => {
    expect(websiteProblem(w)).toBeNull();
  });

  it('a description is counted in characters: 280 emoji pass, 281 do not', () => {
    const ok = servicesSchema.safeParse(tick({ [onField('design')]: true, [descriptionField('design')]: '🎨'.repeat(280) }));
    const long = servicesSchema.safeParse(tick({ [onField('design')]: true, [descriptionField('design')]: '🎨'.repeat(281) }));
    expect(ok.success).toBe(true);
    expect(long.success).toBe(false);
  });

  it('the server\'s reasons land next to the field they name (services.<n>.<field> counts the services sent)', () => {
    const sent = ['coaching', 'events'] as const;
    expect(servicesFieldErrors({ 'services.1.website': ['Enter a secure web address'] }, sent)).toEqual({
      fields: { [websiteField('events')]: 'Enter a secure web address' }, general: null,
    });
    expect(servicesFieldErrors({ services: ['Each service can be listed once.'] }, sent)).toEqual({
      fields: {}, general: 'Each service can be listed once.',
    });
    expect(servicesFieldErrors(undefined, sent)).toEqual({ fields: {}, general: null });
  });
});

describe('services: the screens', () => {
  const section = code('features/reason/entities/EntityServices.tsx');
  const sheet = code('features/reason/entities/EditServicesSheet.tsx');
  const page = code('features/reason/entities/EntityProfilePage.tsx');

  it('the entity page shows them; an empty list is shown only to the people who may edit it', () => {
    expect(section).toContain('if (services.length === 0 && !page.canEdit) return null;');
    expect(section).toContain('{page.canEdit && (');
    expect(page).toContain('{editingServices && page.canEdit && (');
  });

  it('a website is a link only through websiteLink (http or https, never javascript:), in a new tab, without the opener', () => {
    expect(section).toContain('const site = websiteLink(s.website);');
    expect(section).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(section).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('people stay about people: no profile screen reads services', () => {
    const profileFiles = ['features/profile/PublicProfilePage.tsx', 'features/reason/human/HumanProfilePage.tsx', 'features/settings/SettingsPage.tsx']
      .filter((f) => fs.existsSync(path.join(SRC, f)));
    expect(profileFiles.length).toBeGreaterThan(0);
    for (const f of profileFiles) expect({ f, services: /EntityServices|\.services\b|setEntityServices/.test(code(f)) }).toEqual({ f, services: false });
  });

  it('the editor: a portalled Sheet, react-hook-form with the Zod resolver, 44px rows, a counter, the save locked against a double tap', () => {
    expect(sheet).toContain("import Sheet from '../ui/Sheet';");
    expect(sheet).toContain('resolver: formResolver(servicesSchema)');
    expect(sheet).toContain('className="flex min-h-[44px] cursor-pointer items-center gap-3');
    expect(sheet).toContain('{characterCount(description.trim())}/{ENTITY_LIMITS.serviceDescriptionMax}');
    expect(sheet).toContain('if (sending.current) return;');
    expect(sheet).toContain("networkMode: 'always'");
  });

  it('fits 360px: no fixed width wider than a phone in either file', () => {
    for (const s of [section, sheet]) {
      for (const m of s.matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1])).toBeLessThanOrEqual(320);
      expect(s).not.toMatch(/whitespace-nowrap/);
    }
  });
});

describe('export: who sees it and what a refusal says (space-export.ts)', () => {
  it('a circle\'s owner and moderators; nobody else, a platform admin\'s powers included', () => {
    expect(mayExportCircle('owner')).toBe(true);
    expect(mayExportCircle('moderator')).toBe(true);
    expect(mayExportCircle('member')).toBe(false);
    expect(mayExportCircle(null)).toBe(false);
    expect(mayExportCircle(undefined)).toBe(false);
  });

  it('a pod\'s director and hosts', () => {
    expect(mayExportPod('director')).toBe(true);
    expect(mayExportPod('host')).toBe(true);
    expect(mayExportPod('member')).toBe(false);
    expect(mayExportPod(null)).toBe(false);
  });

  it('the file keeps the server\'s name only when it is one of its own shapes', () => {
    const today = new Date('2026-11-11T08:00:00Z');
    expect(exportFileName('pod', 'members', 'attachment; filename="reason-pod-members-2026-11-10.csv"', today)).toBe('reason-pod-members-2026-11-10.csv');
    expect(exportFileName('pod', 'members', 'attachment; filename="../../evil.exe"', today)).toBe('reason-pod-members-2026-11-11.csv');
    expect(exportFileName('circle', 'posts', null, today)).toBe('reason-circle-posts-2026-11-11.csv');
  });

  it('reads the server\'s refusal from a blob, and says it when it is fit to show', async () => {
    const blob = new Blob([JSON.stringify({ success: false, error: { message: "Only the circle's owner and moderators can export its data." } })]);
    const said = await refusalMessage({ response: { status: 403, data: blob } });
    expect(said).toBe("Only the circle's owner and moderators can export its data.");
    expect(downloadFailedLine(403, said, 'circle', false)).toBe(said);
    expect(await refusalMessage({ response: { status: 500, data: new Blob(['<html>']) } })).toBeNull();
    // Fix round 1: an archived circle stays exportable, so a 404 never says "it may have been archived".
    expect(downloadFailedLine(404, null, 'pod', false)).toBe('This pod could not be found, or you no longer run it.');
    expect(downloadFailedLine(404, null, 'circle', false)).not.toMatch(/archived/);
    expect(downloadFailedLine(429, 'You have downloaded a lot of files just now. Try again in a few minutes.', 'pod', false))
      .toBe('You have downloaded a lot of files just now. Try again in a few minutes.');
    expect(downloadFailedLine(undefined, null, 'circle', true)).toMatch(/Connection lost/);
    expect(downloadFailedLine(500, 'SQL error at line 3', 'circle', false)).toBe('Could not download that file just now. Try again in a moment.');
  });
});

describe('export: the screens', () => {
  const circle = code('features/circles/CircleDetailPage.tsx');
  const pod = code('features/pods/PodDetailPage.tsx');
  const sheet = code('features/spaces/SpaceExportSheet.tsx');
  const download = code('features/spaces/download-space-file.ts');

  // Shirley pilot S3 (RSN 11): Export is an entry of each page's Manage menu, the only Export there, by this same rule.
  it('a circle shows Export to its owner and moderators only, in its Manage menu', () => {
    const menu = code('features/circles/CircleManageMenu.tsx');
    expect(menu).toContain('circleManageKeys(circle, mayExportCircle(circle.myRole))');
    expect(menu).toContain("export: { key: 'export', onSelect: () => openSheet('export'), testId: 'circle-export' },");
    expect(circle).not.toContain('data-testid="circle-export"');
    expect(circle).toContain('<SpaceExportSheet kind="circle" spaceId={circle.id} name={circle.name}');
  });

  it('a pod shows Export to its active director and hosts only (never by an admin\'s powers), archived too', () => {
    expect(pod).toContain("const canExport = isMember && mayExportPod(myMembership?.status === 'active' ? myMembership.role : pod.memberRole);");
    expect(pod).toContain("export: { key: 'export', onSelect: () => setExportOpen(true), testId: 'pod-export' },");
    expect(pod).toContain('}, canExport).flatMap(');
    // The menu is drawn in the archived pod's row too, where Export is its only entry.
    expect(pod.match(/<ManageMenu title=\{`Manage \$\{pod\.name\}`\} entries=\{manageEntries\}/g)).toHaveLength(2);
    expect(pod).not.toMatch(/exportButton|data-testid="pod-export"/);
    expect(pod).toContain('{exportOpen && canExport && podId && (');
  });

  it('the sheet says what is never in the files, that each download is recorded, and has a 44px button per file', () => {
    expect(sheet).toContain("import Sheet from '@/features/reason/ui/Sheet';");
    expect(sheet).toMatch(/Never included: email addresses, private profile details, messages/);
    expect(sheet).toMatch(/Each download is recorded first/);
    expect(sheet).toContain('{SPACE_EXPORT_SECTIONS.map((section) => (');
    expect(sheet).toContain('<Button'); // md: min-h-[44px]
    expect(sheet).not.toMatch(/size="sm"/);
    expect(sheet).toContain('if (sending.current) return;');
  });

  it('fix round 1: the Circles page lists the archived circles the member ran, each with Export (their pages stay closed)', () => {
    const section = code('features/circles/ArchivedCirclesSection.tsx');
    expect(code('features/circles/CirclesPage.tsx')).toContain('<ArchivedCirclesSection />');
    expect(section).toContain("queryFn: () => api.get('/circles/archived/mine')");
    expect(section).toContain('meta: { entities: me ? [E.userCircles(me)] : [] },');
    expect(section).toContain('if (!data || data.length === 0) return null;');
    expect(section).toContain('Circles you ran (archived)');
    expect(section).toContain('<SpaceExportSheet kind="circle" spaceId={exporting.id} name={exporting.name}');
    expect(section).toMatch(/We could not load the archived circles you ran\./);
    expect(section).not.toMatch(/to=\{`\/circles\/\$\{c\.id\}`\}/); // never a link to the closed page
    expect(section).not.toMatch(/size="sm"/); // the Button's md size is 44px tall
    expect(code('features/circles/CirclesPage.tsx').split('\n').length).toBeLessThanOrEqual(200);
  });

  it('the download carries the sign-in (lib/api.ts, as a blob), never a new tab', () => {
    expect(download).toContain("import api from '@/lib/api';");
    expect(download).toContain("responseType: 'blob'");
    expect(download).not.toMatch(/window\.open|target="_blank"/);
  });
});

describe('search help: one line, one word (item 21)', () => {
  it('with searches looking: true for hand-made ones too (no claim that onboarding made them); a paused one only when there is one', () => {
    expect(searchesHelp([{ status: 'active' }])).toEqual({
      text: 'Your searches keep looking as people join. REASON sets some up from your onboarding answers, and you can add, edit or pause any of them.',
      link: 'See or edit your searches',
    });
    expect(searchesHelp([{ status: 'active' }, { status: 'paused' }]).text).toMatch(/ A paused one starts again when you resume it\.$/);
    for (const states of [[{ status: 'active' }], [{ status: 'active' }, { status: 'paused' }], undefined] as const) {
      expect(searchesHelp(states).text).not.toMatch(/When you joined|set up searches from your answers\./);
    }
  });

  it('with every open search paused: says so, never "they keep looking"', () => {
    expect(searchesHelp([{ status: 'paused' }])).toEqual({
      text: 'Your search is paused. Resume one and it keeps looking as people join.', link: 'See your searches',
    });
    expect(searchesHelp([{ status: 'paused' }, { status: 'paused' }, { status: 'archived' }]).text)
      .toBe('Your searches are paused. Resume one and it keeps looking as people join.');
  });

  it('while loading, a general line that holds for anyone', () => {
    expect(searchesHelp(undefined)).toEqual({
      text: 'Searches keep looking for the people you want to meet as they join REASON, which sets some up from your onboarding answers.',
      link: 'See your searches',
    });
  });

  it('with none (onboarding skipped, or all archived), offers to set one up', () => {
    expect(searchesHelp([])).toEqual({ text: expect.stringMatching(/^Set up a search/), link: 'Set up a search' });
    expect(searchesHelp([{ status: 'archived' }]).link).toBe('Set up a search');
  });

  it('Find people shows it, linking to the searches page with a 44px tap, from the layout\'s own cache entry', () => {
    expect(code('features/search/SearchPage.tsx')).toContain('<SearchesHelp />');
    const help = code('features/search/SearchesHelp.tsx');
    expect(help).toContain('<Link to="/agents" className="inline-flex min-h-[44px]');
    expect(help).toContain("queryKey: ['agents', false],");
    expect(help).toContain('meta: { entities: me ? [E.user(me)] : [] },');
  });

  it('members read "search", never "agent": the tab, the page, its buttons, its toasts, the home tile and the profile note', () => {
    expect(read('features/reason/shell/PeopleTabs.tsx')).toContain("{ to: '/agents', label: 'Your searches' },");
    expect(code('features/agents/AgentsPage.tsx')).toContain('>Your searches</h1>');
    for (const f of ['features/agents/AgentsPage.tsx', 'features/agents/AgentDetailPage.tsx', 'features/home/HomePage.tsx', 'features/profile/PublicProfilePage.tsx', 'features/search/searches-help.ts']) {
      const visible = [...code(f).matchAll(/'([^'\n]*)'|"([^"\n]*)"|>([^<>{}\n]+)</g)]
        .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
        .filter((t) => !/^[/@.]|^agent-|\/agents|queryKey|^[a-z]+$/.test(t.trim()));
      expect({ f, agent: visible.filter((t) => /\bagents?\b/i.test(t)) }).toEqual({ f, agent: [] });
    }
  });
});
