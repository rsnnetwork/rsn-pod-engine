// "Already met" (10 Nov 2026): the control in the Human Profile's More menu, the chip, and the Everyone row.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadClientModule, readClientSource } from './load-client-module';

const menu = () => loadClientModule('features/reason/human/ProfileMoreMenu.tsx', {
  '../ui/icons': { ReasonIcon: () => null },
}).default as (props: Record<string, unknown>) => JSX.Element;

describe('the More menu item', () => {
  // The menu is closed until pressed, so the open state is read from the source's structure instead.
  const src = readClientSource('features/reason/human/ProfileMoreMenu.tsx');

  it('reads "Already met" and, once marked, "Marked as met · Undo"', () => {
    expect(src).toContain("alreadyMet.marked ? 'Marked as met · Undo' : 'Already met'");
  });

  it('is 44px tall, disabled while a press is on its way, and sits first in the menu', () => {
    expect(src).toContain("const ITEM = 'flex min-h-[44px]");
    expect(src).toMatch(/disabled=\{alreadyMet\.pending\}/);
    expect(src.indexOf('alreadyMet && (')).toBeLessThan(src.indexOf('onClick={choose(onBlock)}'));
  });

  it('draws without error when the page gives no marker (a connected or met person)', () => {
    const html = renderToStaticMarkup(createElement(menu(), { onBlock: () => undefined, onReport: () => undefined, blocking: false }));
    expect(html).not.toContain('Already met');
  });
});

describe('the profile page', () => {
  const page = readClientSource('features/reason/human/HumanProfilePage.tsx');
  it('offers it only to people who are not yet connected or met, and refetches the brief after a press', () => {
    expect(page).toContain("!['connected', 'met'].includes(brief.relationship.state)");
    expect(page).toMatch(/mutationFn: \(met: boolean\) => setAlreadyMet\(userId, met\)/);
    expect(page).toMatch(/invalidateQueries\(\{ queryKey: reasonKeys\.all \}\)/);
  });
  it('labels the chip "You marked as met" only while the state is still none', () => {
    expect(page).toContain("brief.relationship.alreadyMet && brief.relationship.state === 'none' ? 'You marked as met'");
  });
});

describe('the Everyone row', () => {
  const card = () => loadClientModule('features/reason/people/EveryoneCard.tsx', {
    'react-router-dom': { Link: ({ children }: { children?: unknown }) => createElement('a', null, children as never), useNavigate: () => () => undefined },
    '@/components/ui/Avatar': { __esModule: true, default: () => null },
  }).default as (props: Record<string, unknown>) => JSX.Element;
  const person = (alreadyMet: boolean) => ({
    id: 'u-1', displayName: 'Amy Tostenson', avatarUrl: null, company: 'Acme', jobTitle: 'Founder', professionalRole: [],
    pokeStatus: null, pokeSentByOwner: null, relationship: 'none', alreadyMet,
  });
  it('marks the row for the marker and still offers "I want to meet"', () => {
    const html = renderToStaticMarkup(createElement(card(), { person: person(true), onMeet: () => undefined }));
    expect(html).toContain('You marked as met');
    expect(html).toContain('I want to meet');
  });
  it('says nothing for an unmarked person', () => {
    expect(renderToStaticMarkup(createElement(card(), { person: person(false), onMeet: () => undefined }))).not.toContain('You marked as met');
  });
});

describe('People you have met', () => {
  it('shows the label on a marked row', () => {
    expect(readClientSource('features/sessions/EncounterHistoryPage.tsx')).toContain('{e.markedMet && <Badge variant="default">You marked as met</Badge>}');
  });
});
