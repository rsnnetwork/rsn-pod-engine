// server/src/__tests__/client/reason-m1-con01-navigation.test.ts
// CON-01 (Stefan and Claus, 25 Oct 2026): "View full profile" opened a new tab where Back did nothing. The fix has
// four parts on the preview, and each has its pins here or beside it:
//   - ProfileLink opens in the same tab, and a new tab only inside the live event (ws2-profile-link-safety.test.ts);
//   - the shell's page area keeps its place for Back (reason-m1-scroll-memory.test.ts);
//   - the view a member chose (Matches "everyone", the typed search) lives in the address, so Back restores it;
//   - the recap's Message opens in this tab; the live end screen's Message, which must not leave the call page, says it
//     opens a new one.
import * as fs from 'fs';
import * as path from 'path';

const clientFile = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

describe('Matches: "everyone who fits" is in the address (?view=all), so Back from a profile returns to it', () => {
  const page = clientFile('features/matches/MatchesPage.tsx');

  it('the view is read from the address, not held in the page', () => {
    expect(page).toMatch(/import \{ Link, useNavigate, useSearchParams \} from 'react-router-dom';/);
    expect(page).toMatch(/const \[params, setParams\] = useSearchParams\(\);/);
    expect(page).toMatch(/const browse = params\.get\('view'\) === 'all';/);
    expect(page).not.toMatch(/useState\(false\)/);
    // The query still tells the two lists apart.
    expect(page).toContain("queryKey: ['platformMatches', browse]");
  });

  it('choosing a view REPLACES the address, so the page is one history entry and Back leaves it in one press', () => {
    expect(page).toMatch(/const setBrowse = \(all: boolean\) => setParams\(all \? \{ view: 'all' \} : \{\}, \{ replace: true \}\);/);
    expect(page.match(/setBrowse\((true|false)\)/g)).toEqual(['setBrowse(false)', 'setBrowse(true)']);
  });
});

describe('Find people: the typed search is in the address (?q=), so Back from a profile returns to it', () => {
  const page = clientFile('features/search/SearchPage.tsx');

  it('writes the settled term to ?q=, replacing the entry, and only when it differs from what the address already says', () => {
    expect(page).toMatch(/import \{ useEffect, useRef, useState \} from 'react';/);
    expect(page).toMatch(/const \[searchParams, setSearchParams\] = useSearchParams\(\);/);
    expect(page).toMatch(/const written = useRef\(urlQuery\);/);
    expect(page).toMatch(/setSearchParams\(term \? \{ q: term \} : \{\}, \{ replace: true \}\);/);
    expect(page).toMatch(/if \(term === written\.current\) return;/);
  });

  it('follows a new ?q= from outside (the top search bar) but not the page\'s own write, which would undo what the member has typed since', () => {
    expect(page).toMatch(/useEffect\(\(\) => \{\s*if \(urlQuery === written\.current\) return;\s*written\.current = urlQuery;\s*setQ\(urlQuery\);\s*\}, \[urlQuery\]\);/);
  });

  it('does not put the cursor back in the box when it opens on a search that is already there (the keyboard would cover the results Back returned to)', () => {
    expect(page).toMatch(/autoFocus=\{!urlQuery\}/);
  });
});

describe('the Message buttons: the recap opens the conversation in this tab, the live end screen in a new one that says so', () => {
  const recap = clientFile('features/sessions/RecapPage.tsx');
  const end = clientFile('features/live/SessionComplete.tsx');

  it('the recap is a post-event page, not the call: its Message is a link in this tab, so Back returns to the recap', () => {
    const button = recap.slice(recap.indexOf('function MessagePartnerButton'), recap.indexOf('function InterestBadge'));
    expect(button).toMatch(/<Link\b[^>]*to=\{`\/messages\/new\/\$\{userId\}`\}/);
    expect(button).toContain('data-testid={`recap-dm-button-${userId}`}');
    expect(button).not.toMatch(/window\.open|target="_blank"|preventDefault/);
  });

  it('the live end screen keeps its new tab (the call page must not be left), and says so with an arrow and "(opens in a new tab)"', () => {
    const button = end.slice(end.indexOf('function MessagePartnerButton'), end.indexOf('interface Connection'));
    expect(button).toMatch(/window\.open\(`\/messages\/new\/\$\{userId\}`, '_blank', 'noopener,noreferrer'\);/);
    expect(button).toMatch(/<span aria-hidden="true">↗<\/span>/);
    expect(button).toMatch(/<span className="sr-only"> \(opens in a new tab\)<\/span>/);
    expect(button).toContain('data-testid={`recap-dm-button-${userId}`}');
  });
});
