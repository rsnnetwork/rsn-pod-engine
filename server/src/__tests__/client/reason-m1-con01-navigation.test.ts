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
    expect(page).toMatch(/writeAddress\.current\(term \? \{ q: term \} : \{\}, \{ replace: true \}\);/);
    expect(page).toMatch(/if \(term === written\.current\) return;/);
  });

  it('writes when the settled term changes and for no other reason: a new search from the top bar sets the address first, and the old term, which settles a moment later, must not be written over it', () => {
    // Found by reason-m1-shell.spec.ts: the effect depended on the setter too, which changes with every address, so right
    // after the top bar searched "Marta" it wrote the old "Zed Probe" back into the address for a quarter of a second.
    const effect = page.slice(page.indexOf('const writeAddress'), page.indexOf('const [asked'));
    expect(effect).toMatch(/const writeAddress = useRef\(setSearchParams\);\s*writeAddress\.current = setSearchParams;/);
    expect(effect).toMatch(/\}, \[term\]\);/);
    expect(effect).not.toMatch(/\[term, setSearchParams\]/);
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

describe('the live event\'s name links: the arrow takes a little room, so the photo beside the name keeps its size', () => {
  it('every Avatar drawn inside a ProfileLink in the live event has shrink-0, or a long name squeezes it into an oval at 360px', () => {
    const live = path.join(__dirname, '../../../../client/src/features/live');
    const seen: string[] = [];
    const offenders: string[] = [];
    for (const file of fs.readdirSync(live).filter((f) => f.endsWith('.tsx'))) {
      const src = clientFile(`features/live/${file}`);
      for (const block of src.match(/<ProfileLink\b[\s\S]*?<\/ProfileLink>/g) ?? []) {
        for (const avatar of block.match(/<Avatar\b[^>]*\/>/g) ?? []) {
          seen.push(file);
          if (!/\bclassName="[^"]*\bshrink-0\b/.test(avatar)) offenders.push(`${file}: ${avatar}`);
        }
      }
    }
    // The participant list's one and the end screen's two lists.
    expect(seen.sort()).toEqual(['ParticipantList.tsx', 'SessionComplete.tsx', 'SessionComplete.tsx']);
    expect(offenders).toEqual([]);
  });
});

describe('the recap and the live end screen: a row wraps on a phone, so a name gets a line to itself instead of two letters beside the buttons', () => {
  // Measured at 360px with the arrow and the 44px Message button added: the name column was 30 to 60px wide, "W..." and "Cl...".
  for (const file of ['features/sessions/RecapPage.tsx', 'features/live/SessionComplete.tsx']) {
    it(`${file}: both kinds of row wrap, the person's link takes the whole first line below 640px, and the Message button sits at the right of the second`, () => {
      const src = clientFile(file);
      expect(src.match(/className="flex flex-wrap items-center gap-x-3 gap-y-2 p-[23] rounded-lg/g)).toHaveLength(2);
      // (and 44px tall: see the next block)
      expect(src.match(/className="flex items-center gap-3 grow basis-full min-w-0 py-1\.5 -my-1\.5 sm:basis-0"/g)).toHaveLength(2);
      expect(src).not.toMatch(/gap-3 flex-1 min-w-0/);
      expect(src).toMatch(/className="ml-auto shrink-0 inline-flex min-h-\[44px\]/);
    });
  }
});

describe('a name that opens a profile is a 44px target, grown into the padding around it so that nothing moves', () => {
  // Measured: the recap's and the end screen's links were 32 to 40px tall, the participant list's 32px, the chat's 16px. The
  // padding makes the box the height, and the negative margin of the same size pays it back, so the layout is the one it was.
  it('the recap\'s and the end screen\'s two kinds of row: py-1.5 paid back by -my-1.5 (a 32px row of avatar and name becomes 44px)', () => {
    for (const file of ['features/sessions/RecapPage.tsx', 'features/live/SessionComplete.tsx']) {
      expect({ file, links: clientFile(file).match(/ py-1\.5 -my-1\.5 sm:basis-0"/g)?.length }).toEqual({ file, links: 2 });
    }
  });

  it('the participant list\'s row: its 32px photo row becomes 44px inside the row\'s own padding', () => {
    expect(clientFile('features/live/ParticipantList.tsx')).toContain('className="flex items-center gap-2.5 flex-1 min-w-0 py-1.5 -my-1.5"');
  });

  it('the chat\'s name: 14px above and below (16px becomes 44px) and 8px at each side, paid back; the message under it is later in the page, so it stays on top where they overlap', () => {
    const chat = clientFile('features/live/ChatPanel.tsx');
    expect(chat).toContain('className={`-mx-2 -my-3.5 px-2 py-3.5 text-xs font-semibold hover:underline ');
    // The message paragraph comes after the name in the bubble: it is what a tap on the first line of the message reaches.
    expect(chat.indexOf('<ProfileLink newTab')).toBeLessThan(chat.indexOf('<Linkify text={msg.message}'));
  });
});
