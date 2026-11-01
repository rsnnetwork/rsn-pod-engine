// ─── P1 polish on the preview (T16, 1-2 Nov 2026): source pins for screens without a pure helper ─────────────────
//
// Each pin names the behaviour it protects; the measurements behind the layout ones are in task-T16-report.md.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('X4: the event form does not move under a person while the matching choices load', () => {
  const src = read('features/sessions/MatchingSection.tsx');

  it('the loading rows are shaped like the loaded choices: a card per preset (and the admin\'s Other), a name over a line', () => {
    expect(src).toMatch(/data-testid="matching-presets-loading"/);
    expect(src).toMatch(/Array\.from\(\{ length: isAdmin \? 5 : 4 \}/);
    expect(src).toMatch(/<div key=\{i\} className=\{card\(false\)\}>/);
    // Measured: below 400px three of the four presets' lines wrap once, so their placeholders take a second line there.
    expect(src).toMatch(/\{i < 3 && <span className="[^"]*min-\[400px\]:hidden" \/>\}/);
    expect(src).not.toMatch(/h-11 animate-pulse rounded-xl bg-gray-100/);
  });
});

describe('X2: tap targets measured under 44px are 44px at every width', () => {
  it('the pod row link in "Pods in this circle" (42px from 390)', () => {
    expect(read('features/circles/CirclePodsSection.tsx')).toMatch(/<Link to=\{`\/pods\/\$\{p\.podId\}`\} className="flex min-h-\[44px\][^"]*"/);
  });

  it('the host\'s and each participant\'s picture-and-name link on the event page (under 44px from 768)', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toMatch(/<Link to=\{personHref\(hostRow\.userId, 'Events'\)\} className="flex min-h-\[44px\] /);
    expect(page).toMatch(/<Link to=\{personHref\(p\.userId \|\| p\.id, 'Events'\)\} className="flex min-h-\[44px\] /);
  });

  it('the profile\'s Video call holds a fixed 44px and never shrinks in its row (36.5px seen in headless WebKit)', () => {
    expect(read('features/calls/CallButton.tsx')).toMatch(/hero: 'inline-flex h-11 min-h-\[44px\] shrink-0 /);
  });
});
