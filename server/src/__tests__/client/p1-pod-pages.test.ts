// ─── The pod pages after the polish batch (26 Oct 2026, P1 items 2, 3, 15, 16) ────────────────────────────────
//
// Source pins on the preview's client (reason-m1): what a person sees on the pods list, the admin's pods list and
// a pod's page. Each pin names the behaviour it protects.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

describe('the pods list (PodsPage.tsx)', () => {
  const src = read('features/pods/PodsPage.tsx');

  it('says Active, Archived, Suspended or Draft, never the raw status word (item 3)', () => {
    expect(src).toMatch(/import \{[^}]*podStatusLabel[^}]*\} from '\.\/pod-header-text'/);
    expect(src).toMatch(/\{podStatusLabel\(pod\.status\)\}/);
    expect(src).not.toMatch(/>\s*\{pod\.status\}\s*</);
  });

  it('a long unbroken pod name or description breaks inside the card instead of widening the page (item 2)', () => {
    // The card is a grid item and the text block a flex item: each keeps its min-content width (the whole word)
    // unless it may shrink (min-w-0), and only then does break-words get a box narrow enough to break in.
    expect(src).toMatch(/<Card key=\{pod\.id\} hover onClick=\{\(\) => navigate\(`\/pods\/\$\{pod\.id\}`\)\} className="[^"]*min-w-0[^"]*"/);
    expect(src).toMatch(/className="[^"]*min-w-0[^"]*"[^>]*>\s*<p className="[^"]*break-words[^"]*">\{pod\.name\}<\/p>/);
    expect(src).toMatch(/<p className="[^"]*break-words[^"]*">\s*\{pod\.memberCount/);
  });
});

describe('the admin pods list (AdminPodsPage.tsx)', () => {
  const src = read('features/admin/AdminPodsPage.tsx');

  it('says Active, Archived, Suspended or Draft, never the raw status word (item 3)', () => {
    expect(src).toMatch(/import \{[^}]*podStatusLabel[^}]*\} from '\.\.\/pods\/pod-header-text'/);
    expect(src).toMatch(/\{podStatusLabel\(pod\.status\)\}/);
    expect(src).not.toMatch(/>\s*\{pod\.status\}\s*</);
  });

  it('a long pod name breaks inside its row (item 2)', () => {
    // The card is a grid item and the name a flex item: each must be allowed to shrink (min-w-0) for break-words
    // to break the word.
    expect(src).toMatch(/<Card key=\{pod\.id\} className="[^"]*min-w-0[^"]*">/);
    expect(src).toMatch(/<h3 className="[^"]*min-w-0[^"]*break-words[^"]*"/);
  });
});

describe('a pod\'s page (PodDetailPage.tsx)', () => {
  const src = read('features/pods/PodDetailPage.tsx');

  it('reads up to a hundred of the pod\'s events, not the default page of twenty (item 15)', () => {
    expect(src).toMatch(/const EVENTS_PAGE = 100;/);
    expect(src).toMatch(/\/sessions\?podId=\$\{podId\}&pageSize=\$\{EVENTS_PAGE\}/);
  });

  it('says when there are more events than it shows (item 15)', () => {
    expect(src).toMatch(/and more/);
  });

  it('asks whether the viewer is an admin through the one helper every screen uses (item 16)', () => {
    expect(src).toMatch(/import \{[^}]*\bisAdmin\b[^}]*\} from '@\/lib\/utils'/);
    expect(src).toMatch(/mayReadEvents = !!pod\?\.memberRole \|\| isAdmin\(user\?\.role\)/);
    expect(src).not.toMatch(/user\?\.role === 'admin' \|\| user\?\.role === 'super_admin'/);
  });

  it('the header\'s name and description break inside the page at 360 (item 16)', () => {
    expect(src).toMatch(/<h1 className="[^"]*break-words[^"]*">\{pod\.name\}<\/h1>/);
    expect(src).toMatch(/<p className="[^"]*break-words[^"]*">\{pod\.description \|\| 'No description'\}<\/p>/);
  });
});
