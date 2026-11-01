// ─── A circle's Organisations (T15, 1 Nov 2026; 30 Oct review 7.3) ───────────────────────────────────────────────
// The circle page's section of the entities linked to it, and the managers' Link an entity sheet. Like the other
// client pins here it reads the source (the page needs a router, a store and a browser to run).
import * as fs from 'fs';
import * as path from 'path';

const src = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(src, rel), 'utf8').replace(/\r\n/g, '\n');
const section = () => read('features/circles/CircleOrganisationsSection.tsx');
const sheet = () => read('features/circles/LinkEntitySheet.tsx');

describe('the circle page: Organisations (T15)', () => {
  it('sits after the pods and only when the circle is not locked (a closed circle shows outsiders nothing of it)', () => {
    const page = read('features/circles/CircleDetailPage.tsx');
    expect(page).toMatch(/\{!circle\.locked && <CirclePodsSection circle=\{circle\} \/>\}\n\n\s*\{!circle\.locked && <CircleOrganisationsSection circle=\{circle\} \/>\}/);
  });
  it('draws the linked entities with the Entities pages\' own rows and logos, with an empty state for managers', () => {
    expect(section()).toMatch(/<EntityRows\n\s*entities=\{entities\}/);
    expect(section()).toMatch(/if \(entities\.length === 0 && !manager\) return null;/);
    expect(section()).toMatch(/\{ORGANISATIONS_EMPTY\}/);
    expect(read('features/circles/circle-logic.ts')).toMatch(/export const ORGANISATIONS = 'Organisations';/);
    expect(read('features/circles/circle-logic.ts')).toMatch(/entities\?: CircleEntityLink\[\];/);
  });
  it('gives Link an entity and a 44px Unlink (which asks first) only to the people who run it', () => {
    expect(section()).toMatch(/\{manager && \(\n\s*<button type="button" onClick=\{\(\) => setLinking\(true\)\}/);
    expect(section()).toMatch(/trailing=\{manager \? \(e\) => \(/);
    expect(section()).toMatch(/min-h-\[44px\] min-w-\[44px\]/);
    expect(section()).toMatch(/await ask\(\{ title: `Unlink \$\{name\}\?`/);
    expect(section()).toMatch(/api\.delete\(`\/circles\/\$\{circle\.id\}\/entities\/\$\{entityId\}`\)/);
  });
  it('the sheet searches the Entities list\'s own search, leaves out what is linked, and links with the entity id', () => {
    expect(sheet()).toMatch(/queryKey: entityKeys\.list\(term\),/);
    expect(sheet()).toMatch(/meta: \{ entities: me \? \[E\.userEntities\(me\)\] : \[\] \},/);
    expect(sheet()).toMatch(/\.filter\(\(e\) => !linked\.includes\(e\.id\)\)/);
    expect(sheet()).toMatch(/api\.post\(`\/circles\/\$\{circleId\}\/entities`, \{ entityId \}\)/);
    expect(sheet()).toMatch(/networkMode: 'always',/);
    // Loading, error and empty states.
    expect(sheet()).toMatch(/aria-busy="true"/);
    expect(sheet()).toMatch(/We could not search entities just now\./);
    expect(sheet()).toMatch(/No entity on REASON matches/);
  });
  it('a link or an unlink reads the circle and every entity screen again on this screen (the tags tell the others)', () => {
    for (const s of [section(), sheet()]) {
      expect(s).toMatch(/refreshCircle\(qc, circle(?:\.id|Id)\), qc\.invalidateQueries\(\{ queryKey: entityKeys\.all \}\)/);
      expect(s).not.toMatch(/setQueryData/);
    }
  });
});

// T15 client review M1: Unlink as CircleMembersSection's Remove does it: a mutation, guarded before the confirm, busy.
describe('the circle page: Unlink is guarded and shows it is working (review M1)', () => {
  it('goes through one useMutation (networkMode always), refuses a second press while one is on its way, and is busy', () => {
    expect(section()).toMatch(/const unlinking = useMutation\(\{\n\s*networkMode: 'always',/);
    expect(section()).toMatch(/if \(unlinking\.isPending\) return;\n\s*if \(!\(await ask\(/);
    expect(section()).toMatch(/disabled=\{unlinking\.isPending\}/);
    expect(section()).toMatch(/aria-busy=\{unlinking\.isPending && unlinking\.variables\?\.entityId === e\.id\}/);
    expect(section()).not.toMatch(/await api\.delete/);
  });
});

// Fix round 1 (found by the spec): the Unlink mutation sat below the early return, so a member whose circle had no
// organisations, then got one, rendered one more hook than before and the section never drew.
describe('the circle page: every hook runs before the section decides to draw nothing', () => {
  it('useMutation and useConfirm come before `return null`', () => {
    const s = section();
    const early = s.indexOf('if (entities.length === 0 && !manager) return null;');
    expect(early).toBeGreaterThan(0);
    for (const hook of ['useMutation(', 'useConfirm(', 'useState(', 'useQueryClient(', 'useToastStore(']) {
      expect({ hook, before: s.indexOf(hook) > 0 && s.indexOf(hook) < early }).toEqual({ hook, before: true });
    }
  });
});
