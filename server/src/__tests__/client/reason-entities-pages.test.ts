// server/src/__tests__/client/reason-entities-pages.test.ts
// The Entities pages' markup and wiring that an edit could quietly undo (21 Oct 2026, Task 11). Like the other client
// tests here it reads the source: the pages need a router, a store and a browser to run. What the pages SAY, and the
// rules behind them, are executed in reason-entities-text.test.ts.
import * as fs from 'fs';
import * as path from 'path';

const src = path.join(__dirname, '../../../../client/src');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(src, rel), 'utf8').replace(/\r\n/g, '\n');
const dir = 'features/reason/entities';
const files = () => fs.readdirSync(path.join(src, dir)).filter((f) => /\.tsx?$/.test(f)).map((f) => ({ f, s: read(`${dir}/${f}`) }));
const page = (name: string) => read(`${dir}/${name}`);
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

describe('Entities: every query is told by the contract\'s realtime tags', () => {
  it('the list (and the create form\'s "already on REASON", which shares its cache) listens for the member\'s own entities', () => {
    for (const f of ['EntitiesPage.tsx', 'AlreadyOnReason.tsx']) {
      expect(page(f)).toMatch(/queryKey: entityKeys\.list\(term\),/);
      expect(page(f)).toMatch(/meta: \{ entities: me \? \[E\.userEntities\(me\)\] : \[\] \},/);
    }
  });
  it('an entity\'s page listens for the entity and for the member\'s own entities', () => {
    expect(page('EntityProfilePage.tsx')).toMatch(/meta: \{ entities: me && validId \? \[E\.entity\(entityId\), E\.userEntities\(me\)\] : \[\] \},/);
    expect(page('NameTaken.tsx')).toMatch(/meta: \{ entities: me \? \[E\.entity\(taken\.id\), E\.userEntities\(me\)\] : \[\] \},/);
  });
  it('there are exactly those four queries', () => {
    expect(files().reduce((n, { s }) => n + count(s, /\buseQuery\(/g), 0)).toBe(4);
  });
  it('a write never edits the cache by hand: it refreshes every entity screen (and the tags tell the other tabs and people)', () => {
    for (const { f, s } of files()) {
      expect({ f, hit: /setQueryData|setQueriesData/.test(s) }).toEqual({ f, hit: false });
      for (const m of s.matchAll(/useMutation\(\{[\s\S]*?onSuccess: [^\n]*\n([\s\S]*?)\n {4}\},\n/g)) {
        expect({ f, refreshes: /qc\.invalidateQueries\(\{ queryKey: entityKeys\.all \}\)/.test(m[1]) }).toEqual({ f, refreshes: true });
      }
    }
  });
  it('every write fails at once when offline (networkMode always), and a double tap is one request (a ref, checked first)', () => {
    let mutations = 0;
    for (const { f, s } of files()) {
      const n = count(s, /useMutation\(\{/g);
      mutations += n;
      expect({ f, always: count(s, /useMutation\(\{\s*networkMode: 'always',/g) }).toEqual({ f, always: n });
      if (n > 0) expect({ f, lock: /if \((?:!joinAs \|\| )?(?:sending|joining|busy)\.current\) return;/.test(s) }).toEqual({ f, lock: true });
    }
    // Create, edit, role, join (from a 409), join (on the page), leave, archive.
    expect(mutations).toBe(7);
  });
});

describe('Entities: the routes and the coming-soon page', () => {
  it('/entities is the Entities page, and /entities/:entityId the full-screen entity profile with its own toasts', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/<Route path="\/entities" element=\{<EntitiesPage \/>\} \/>/);
    expect(app).toMatch(/<Route path="\/entities\/:entityId" element=\{<ProtectedRoute><><EntityProfilePage \/><ToastContainer \/><\/><\/ProtectedRoute>\} \/>/);
  });
  it('the coming-soon page is gone (Entities is real, Introductions went), so nothing can route to it', () => {
    expect(fs.existsSync(path.join(src, 'features/reason/shell/ComingSoonPage.tsx'))).toBe(false);
    expect(read('App.tsx')).not.toMatch(/ComingSoonPage|Entities matter\./);
  });
});

describe('Entities: the list page', () => {
  it('has the brief\'s title and subtitle', () => {
    expect(page('EntitiesPage.tsx')).toMatch(/<PageHead eyebrow="THE NETWORK AROUND PEOPLE" title="Entities" subtitle="Companies and organisations, and the people around them\." pose="thinking" \/>/);
  });
  it('?create=1 opens the create sheet, which is mounted only while open (every opening starts from the defaults)', () => {
    const p = page('EntitiesPage.tsx');
    expect(p).toMatch(/const creating = params\.get\('create'\) === '1';/);
    expect(p).toMatch(/\{creating && <CreateEntitySheet startName=\{startName\} onClose=\{\(\) => setCreate\(false\)\} \/>\}/);
    // Opening and closing it replaces the address, so Back does not step through a sheet.
    expect(p).toMatch(/\}, \{ replace: true \}\);/);
  });
  it('"Create your company" is the button in "Your entities"', () => {
    expect(page('YourEntities.tsx')).toMatch(/onClick=\{onCreate\}[^>]*>Create your company<\/button>/);
  });
  it('two cards a row from 1024px, one list below that', () => {
    expect(page('YourEntities.tsx')).toMatch(/export const CARD_GRID = 'grid grid-cols-1 gap-3 min-\[1024px\]:grid-cols-2 min-\[1024px\]:gap-3\.5';/);
    expect(page('OtherEntities.tsx')).toMatch(/CARD_GRID/);
  });
  it('the search box searches through searchTerm (2 characters or the recent list), debounced, and says so for one character', () => {
    expect(page('EntitiesPage.tsx')).toMatch(/const term = searchTerm\(useDebouncedValue\(typed, 300\)\);/);
    expect(page('OtherEntities.tsx')).toMatch(/Type at least 2 characters to search\./);
    expect(page('OtherEntities.tsx')).toMatch(/aria-label="Search entities"/);
  });
  it('has a loading, an empty and an error state', () => {
    expect(page('YourEntities.tsx')).toMatch(/Loading your entities/);
    expect(page('YourEntities.tsx')).toMatch(/You are not linked to an entity yet\./);
    expect(page('OtherEntities.tsx')).toMatch(/No other entities yet\./);
    expect(page('EntitiesPage.tsx')).toMatch(/We could not load entities just now\./);
    expect(page('EntitiesPage.tsx')).toMatch(/onClick=\{\(\) => void list\.refetch\(\)\}/);
  });
});

describe('Entities: the create sheet', () => {
  it('has the brief\'s fields in the brief\'s order: name, type, your role, your title, location, size, about, website', () => {
    const fields = page('EntityFields.tsx');
    const sheet = page('CreateEntitySheet.tsx');
    const order = (s: string, labels: string[]) => labels.map((l) => s.indexOf(`label="${l}"`));
    const detail = order(fields, ['Name', 'Type', 'Location', 'Size', 'About', 'Website']);
    expect([...detail].sort((a, b) => a - b)).toEqual(detail);
    expect(detail.every((i) => i >= 0)).toBe(true);
    // Role and title are the create form's own, placed straight after the type.
    expect(fields.indexOf('{afterKind}')).toBeGreaterThan(detail[1]);
    expect(fields.indexOf('{afterKind}')).toBeLessThan(detail[2]);
    expect(sheet).toMatch(/<SelectField label="Your role"/);
    expect(sheet).toMatch(/<TextField label="Your title" optional/);
  });
  it('a 409 shows the name taken, with Open it and Join it', () => {
    const box = page('NameTaken.tsx');
    expect(box).toMatch(/There is already an entity called \{name\}\./);
    expect(box).toMatch(/>Open it<\/Link>/);
    expect(box).toMatch(/'Join it'/);
    expect(page('CreateEntitySheet.tsx')).toMatch(/const existingId = nameTakenId\(err\);/);
  });
  it('a refused field says why next to itself, and the submit button sits in the footer as the form\'s own (Enter sends it)', () => {
    const sheet = page('CreateEntitySheet.tsx');
    expect(sheet).toMatch(/setFieldError\(field as keyof CreateFormValues, \{ type: 'server', message \}\)/);
    expect(sheet).toMatch(/<button type="submit" form=\{formId\}/);
    expect(sheet).toMatch(/<form id=\{formId\} onSubmit=\{submit\} noValidate/);
  });
  it('uses react-hook-form with the Zod schemas', () => {
    expect(page('CreateEntitySheet.tsx')).toMatch(/resolver: formResolver\(createSchema\)/);
    expect(page('EditEntitySheet.tsx')).toMatch(/resolver: formResolver\(editSchema\)/);
    expect(page('RoleSheet.tsx')).toMatch(/resolver: formResolver\(roleSchema\)/);
  });
});

describe('Entities: the entity profile', () => {
  it('only an id that is an entity\'s is asked for, in the one spelling the server uses', () => {
    const p = page('EntityProfilePage.tsx');
    expect(p).toMatch(/const entityId = param\.toLowerCase\(\);/);
    expect(p).toMatch(/const validId = isEntityId\(entityId\);/);
    expect(p).toMatch(/enabled: validId && !!me && !closing,/);
    expect(p).toMatch(/retry: shouldRetry,/);
  });
  it('has loading, not available and could not load screens', () => {
    const p = page('EntityProfilePage.tsx');
    expect(p).toMatch(/Loading this entity/);
    expect(p).toMatch(/This entity is not available\./);
    expect(p).toMatch(/We could not load this entity just now\./);
  });
  it('"People around this entity" opens each person\'s profile, and you your own', () => {
    const people = page('EntityPeople.tsx');
    expect(people).toMatch(/People around this entity/);
    expect(people).toMatch(/to=\{you \? '\/profile' : `\/people\/\$\{p\.id\}`\}/);
    expect(people).toMatch(/roleLine\(p\.role, p\.title\)/);
  });
  it('"Your relationship" offers Change and Leave, or Join with a role', () => {
    const rel = page('RelationshipPanel.tsx');
    expect(rel).toMatch(/Your relationship/);
    expect(rel).toMatch(/>Change<\/button>/);
    expect(rel).toMatch(/>Leave<\/button>/);
    expect(rel).toMatch(/'Join'/);
    expect(rel).toMatch(/<option value="">Choose your role<\/option>/);
  });
  it('leaving and archiving ask first; Edit and Archive are for those who may (canEdit)', () => {
    expect(page('RelationshipPanel.tsx')).toMatch(/<ConfirmSheet\s+open=\{leaving\}/);
    expect(page('EntityProfilePage.tsx')).toMatch(/<ConfirmSheet\s+open=\{archiving\}/);
    expect(page('EntityHero.tsx')).toMatch(/\{page\.canEdit && \(/);
    expect(page('EntityProfilePage.tsx')).toMatch(/\{editing && page\.canEdit && <EditEntitySheet/);
  });
  it('a page that is archived (by you, or by your leaving last) is left for the list, replacing it in the history', () => {
    expect(page('EntityProfilePage.tsx')).toMatch(/navigate\('\/entities', \{ replace: true \}\);/);
    expect(page('RelationshipPanel.tsx')).toMatch(/if \(result\.archived\) navigate\('\/entities', \{ replace: true \}\);/);
  });
  // Found by watching the page (a MutationObserver, Chromium and WebKit): the route change is a transition, so the
  // archived page stayed on screen a moment after the address changed, and its own 404 drew "not available" there.
  it('while an archive or a leave is out, the page does not ask for itself, so its 404 never flashes "not available" on the way out', () => {
    const p = page('EntityProfilePage.tsx');
    const rel = page('RelationshipPanel.tsx');
    expect(p).toMatch(/enabled: validId && !!me && !closing,/);
    expect(p).toMatch(/onClosing=\{setClosing\}/);
    for (const src of [p, rel]) {
      expect(src).toMatch(/onMutate: \(\) => onClosing\(true\),/);
      expect(src).toMatch(/onError: \(err\) => \{\s*onClosing\(false\);/);
    }
    // A leave that did not archive it: the page asks again (it is stale by then).
    expect(rel).toMatch(/if \(result\.archived\) navigate\('\/entities', \{ replace: true \}\);\s*else onClosing\(false\);/);
  });
  it('the website is a link only through websiteLink (http or https), opened apart from the app', () => {
    const hero = page('EntityHero.tsx');
    expect(hero).toMatch(/const site = websiteLink\(e\.website\);/);
    expect(hero).toMatch(/<a href=\{site\.href\} target="_blank" rel="noopener noreferrer nofollow ugc"/);
    expect(count(hero, /href=/g)).toBe(1);
  });
});

describe('Entities: words, sizes and colours', () => {
  it('never says RSN or session to a member', () => {
    for (const { f, s } of files()) {
      const text = s.replace(/^\s*\/\/.*$/gm, '');
      expect({ f, rsn: /\bRSN\b/.test(text), session: /\bsessions?\b/i.test(text) }).toEqual({ f, rsn: false, session: false });
    }
  });
  it('uses none of the greys that fail 4.5:1, and no brand-red text (the darker red reads on white and pink)', () => {
    for (const { f, s } of files()) {
      expect({ f, grey: /#7b8190|#8b8f96/i.test(s), red: /(?<![\w-])text-reason-red(?!-hover)/.test(s) }).toEqual({ f, grey: false, red: false });
    }
  });
  it('every field is 16px on a phone (iPhone Safari zooms into anything smaller)', () => {
    for (const { f, s } of files()) {
      for (const m of s.matchAll(/<(input|select|textarea)\b[\s\S]*?className=\{?(?:cn\()?([^>]*?)>/g)) {
        expect({ f, tag: m[1], phone16: /text-\[16px\]|CONTROL/.test(m[2]) }).toEqual({ f, tag: m[1], phone16: true });
      }
    }
    expect(page('EntityFields.tsx')).toMatch(/const CONTROL = '[^']*\btext-\[16px\][^']*\bmd:text-\[14px\]/);
  });
  it('every button look is at least 44px tall', () => {
    const look = page('look.ts');
    for (const name of ['PRIMARY_BUTTON', 'QUIET_BUTTON']) {
      expect(look).toMatch(new RegExp(`export const ${name} = '[^']*\\bmin-h-\\[44px\\]`));
    }
  });
});
