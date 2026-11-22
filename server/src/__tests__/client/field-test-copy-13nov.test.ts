// ─── Field test, 13 Nov 2026: "Improve the default message, profile edit visibility and ratings clarity" ──────────
//
// The Meet sheet's note greets the person by first name; Edit profile is near the top of your profile and in both
// account menus; the live rating form says what each star means, what Meet again does and who sees what, and the
// recap's late rating names its Meet again. Drawn to markup where a component can be drawn, read as source where the
// thing to pin is where an element sits.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const words = () => loadClientModule('features/live/rating-words.ts', {}) as {
  STAR_MEANINGS: readonly string[];
  STAR_PROMPT: string;
  starLabel: (n: number) => string;
  starHint: (n: number) => string;
  MEET_AGAIN_LABEL: string;
  MEET_AGAIN_HELP: string;
  STARS_PRIVATE: string;
  DIDNT_WORK_HELP: string;
};
const toastStore = { useToastStore: (sel?: (s: { addToast: () => void }) => unknown) => {
  const state = { addToast: () => undefined };
  return sel ? sel(state) : state;
} };
const cnStandIn = { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') };

describe('the Meet sheet\'s default note', () => {
  const note = () => loadClientModule('features/reason/human/meet-note.ts', {}) as {
    defaultMeetNote: (name: string | null | undefined) => string;
    firstNameOf: (name: string | null | undefined) => string | null;
  };
  const WITH = (first: string) => `Hi ${first}, I think we have a good reason to talk. Would you be up for a short call to compare notes?`;
  const WITHOUT = 'Hi, I think we have a good reason to talk. Would you be up for a short call to compare notes?';

  it('greets the person by their first name', () => {
    expect(note().defaultMeetNote('Shradha Adhikari')).toBe(WITH('Shradha'));
    expect(note().defaultMeetNote('  Stefan   Avivson ')).toBe(WITH('Stefan'));
    expect(note().defaultMeetNote('Claus')).toBe(WITH('Claus'));
  });

  it('says only "Hi" when there is no name to greet, never "undefined", "null" or the "Member" placeholder', () => {
    for (const name of [undefined, null, '', '   ', 'Member']) {
      expect({ name, note: note().defaultMeetNote(name) }).toEqual({ name, note: WITHOUT });
    }
  });

  const sheet = () => loadClientModule('features/reason/human/MeetSheet.tsx', {
    '@tanstack/react-query': {
      useQueryClient: () => ({ invalidateQueries: () => undefined }),
      useMutation: () => ({ mutate: () => undefined, isPending: false, variables: undefined }),
    },
    '@/lib/utils': cnStandIn,
    '@/stores/toastStore': toastStore,
    '../ui/Sheet': {
      __esModule: true,
      default: ({ open, title, children, footer }: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) =>
        (open ? createElement('div', { 'data-sheet': title }, children, footer) : null),
    },
    '../api': { errorMessage: () => '', reasonKeys: { all: ['reason'] }, sendMeetRequest: () => Promise.resolve() },
    // A member who saved no standard message (21 Nov 2026): the sheet opens on REASON's own.
    './useMeetDefaults': { useMeetDefaults: () => ({ data: { note: null, format: null } }) },
  }).default as (props: Record<string, unknown>) => JSX.Element;
  const draw = (person: { userId: string; displayName: string } | null) =>
    renderToStaticMarkup(createElement(sheet(), { person, onClose: () => undefined }));

  it('opens with the note already addressed to the person, still in an editable box', () => {
    const html = draw({ userId: 'u1', displayName: 'Shradha Adhikari' });
    expect(html).toContain('data-sheet="Meet Shradha Adhikari"');
    expect(html).toMatch(/<textarea[^>]*>Hi Shradha, I think we have a good reason to talk\. Would you be up for a short call to compare notes\?<\/textarea>/);
    expect(html).toContain('Send request');
  });

  it('a person shown as "Member" (no name) gets the plain greeting', () => {
    expect(draw({ userId: 'u2', displayName: 'Member' })).toMatch(/<textarea[^>]*>Hi, I think we have a good reason to talk\./);
  });

  it('the old prototype text is gone from the client', () => {
    expect(readClientSource('features/reason/human/MeetSheet.tsx')).not.toMatch(/useful reason to speak/);
  });
});

describe('Edit profile is easy to find', () => {
  it('on your profile it sits in the hero, under your name, and nowhere else on the page', () => {
    const page = readClientSource('features/reason/profile/YourProfilePage.tsx');
    const hero = page.slice(page.indexOf('<HeroFrame'), page.indexOf('note={<NoteBox'));
    expect(hero).toMatch(/actions=\{\([\s\S]*<Link to=\{EDIT_PROFILE_TO\} className=\{PRIMARY\}>Edit profile<\/Link>[\s\S]*\)\}/);
    expect(page.match(/>Edit profile</g)).toHaveLength(1);
    // The row at the foot of the page keeps the other two.
    expect(page).toMatch(/<Link to=\{EDIT_ANSWERS_TO\} className=\{QUIET\}>Edit answers<\/Link>/);
    expect(page).toMatch(/data-testid="preview-profile">Preview as others see it<\/Link>/);
  });

  it('the hero draws its actions right after the name, role and links', () => {
    const hero = readClientSource('features/reason/human/ProfileHero.tsx');
    const frame = hero.slice(hero.indexOf('export function HeroFrame'));
    expect(frame.indexOf('{who.name}</h1>')).toBeLessThan(frame.indexOf('{actions}'));
    expect(frame.indexOf('{actions}')).toBeLessThan(frame.indexOf('{who.bio &&'));
  });

  it('the sidebar\'s account menu and the phone\'s More sheet both link to the form, right after View profile', () => {
    const menu = readClientSource('features/reason/shell/ProfileMenu.tsx');
    expect(menu.indexOf('label="View profile"')).toBeLessThan(menu.indexOf('label="Edit profile"'));
    expect(menu.indexOf('label="Edit profile"')).toBeLessThan(menu.indexOf('label="Invite someone"'));
    const more = readClientSource('features/reason/shell/MobileNav.tsx');
    const sheet = more.slice(more.indexOf('<Sheet open={moreOpen}'), more.indexOf('</Sheet>'));
    expect(sheet.indexOf('View profile')).toBeLessThan(sheet.indexOf('>Edit profile</Link>'));
    expect(sheet.indexOf('>Edit profile</Link>')).toBeLessThan(sheet.indexOf('>Invite someone</Link>'));
    // Drawn like its neighbours: a 44px row, marked like them while you are on it.
    expect(sheet).toMatch(/<Link to="\/profile\/edit"[^>]*className=\{cn\(ACCOUNT_LINK, onProfileEdit\(pathname\) && ACCOUNT_LINK_HERE\)\}>Edit profile<\/Link>/);
  });
});

describe('the live rating form', () => {
  const state = {
    currentMatch: { userId: 'u2', displayName: 'Shradha Adhikari' },
    currentMatchId: 'm1',
    currentPartners: [] as unknown[],
    ratingReason: null,
    currentRound: 1,
    totalRounds: 3,
    ratedMatchIds: new Set<string>(),
  };
  const prompt = () => loadClientModule('features/live/RatingPrompt.tsx', {
    'lucide-react': iconStandIns,
    '@/components/ui/Button': {
      Button: ({ children, isLoading: _l, ...rest }: { children?: ReactNode; isLoading?: boolean }) => createElement('button', rest, children),
    },
    '@/stores/sessionStore': {
      useSessionStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
        getState: () => ({ setPhase: () => undefined, setLastRatedRound: () => undefined, addRatedMatchId: () => undefined }),
      }),
    },
    '@/stores/toastStore': toastStore,
    '@/lib/api': { __esModule: true, default: { post: () => Promise.resolve() } },
    '@/lib/socket': { getSocket: () => ({ emit: () => undefined }) },
  }).default as (props: Record<string, unknown>) => JSX.Element;
  const html = () => renderToStaticMarkup(createElement(prompt(), { sessionId: 's1' }));

  it('each star says what it is worth', () => {
    const page = html();
    for (const n of [1, 2, 3, 4, 5]) expect(page).toContain(`aria-label="${n} out of 5"`);
    // The e2e helpers find the stars by their icon; it stays inside each button.
    expect(page.match(/<button[^>]*aria-label="\d out of 5"[^>]*><svg data-icon="Star"/g)).toHaveLength(5);
  });

  it('before a star is chosen it says how to rate, and Submit (off) points at that line', () => {
    const page = html();
    expect(page).toContain('Tap a star to rate');
    expect(page).not.toContain('Tap the stars to rate');
    const hintId = page.match(/<p id="([^"]+)" aria-live="polite"[^>]*>Tap a star to rate<\/p>/)?.[1];
    expect(hintId).toBeTruthy();
    expect(page).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-describedby="${hintId}"[^>]*>Submit Rating</button>|<button[^>]*aria-describedby="${hintId}"[^>]*disabled=""[^>]*>Submit Rating</button>`));
  });

  it('the line under the stars names the chosen value', () => {
    const w = words();
    expect([0, 1, 2, 3, 4, 5].map(w.starHint)).toEqual(['Tap a star to rate', 'Not useful', 'Okay', 'Good', 'Very good', 'Excellent']);
    expect(w.starLabel(4)).toBe('4 out of 5');
  });

  it('Meet again is a toggle with a fixed name, at least 44px, explained on the screen', () => {
    const page = html();
    const w = words();
    const toggle = page.match(/<button[^>]*aria-pressed="false"[^>]*aria-describedby="([^"]+)"[^>]*class="([^"]*)"[^>]*>[\s\S]*?I would meet again<\/button>/);
    expect(toggle).toBeTruthy();
    expect(toggle![2]).toMatch(/min-h-\[48px\]/);
    expect(page).toContain(`<p id="${toggle![1]}" class="mt-2 mb-5 text-xs leading-relaxed text-gray-500">${w.MEET_AGAIN_HELP}</p>`);
    // The e2e helper's name for it still finds it.
    expect(w.MEET_AGAIN_LABEL).toMatch(/Would you meet again|Would meet again/i);
  });

  it('what the partner sees is said exactly: a one-sided Meet again is shown to them, the stars are not', () => {
    const w = words();
    expect(w.MEET_AGAIN_HELP).toBe('If you both choose to meet again, it is a mutual match. If only you do, they see that you wanted to.');
    expect(w.STARS_PRIVATE).toBe('Your stars are not shown to them.');
    expect(html()).toContain(w.STARS_PRIVATE);
    // The claims rest on these: the recap and the end screen show the partner's Meet again ("They wanted to meet
    // again") and only the stars you gave yourself.
    for (const file of ['features/live/SessionComplete.tsx', 'features/sessions/RecapPage.tsx']) {
      expect(readClientSource(file)).toContain('They wanted to meet again');
    }
  });

  it('"This conversation didn\'t work" is explained under it, not in a tooltip', () => {
    const page = html();
    const w = words();
    const button = page.match(/<button[^>]*aria-describedby="([^"]+)"[^>]*>This conversation didn(?:&#x27;|')t work<\/button>/);
    expect(button).toBeTruthy();
    expect(page).toContain(`<p id="${button![1]}" class="text-xs text-gray-500">${w.DIDNT_WORK_HELP}</p>`);
    expect(readClientSource('features/live/RatingPrompt.tsx')).not.toMatch(/\btitle="/);
  });

  it('the confirmation stays long enough to read, and a tap still moves on at once', () => {
    const src = readClientSource('features/live/RatingPrompt.tsx');
    expect(src).toContain('const CONFIRMATION_MS = 1800;');
    expect(src).toContain('setTimeout(onContinue, CONFIRMATION_MS)');
    expect(src).toMatch(/cursor-pointer shadow-lg" onClick=\{onContinue\}/);
  });
});

describe('the recap\'s late rating', () => {
  const src = () => readClientSource('features/sessions/RecapPage.tsx');
  const form = () => src().slice(src().indexOf('function LateRatingForm'), src().indexOf('export default function RecapPage'));

  it('stars carry their worth and Meet again has a visible label and a pressed state', () => {
    expect(form()).toMatch(/aria-label=\{starLabel\(n\)\}/);
    expect(form()).toMatch(/aria-pressed=\{n === rating\}/);
    expect(form()).toMatch(/aria-pressed=\{meetAgain\}/);
    expect(form()).toMatch(/<Handshake aria-hidden="true"[^>]*\/>\s*Meet again\s*<\/button>/);
  });

  it('every button there is at least 44px, and the row wraps on a phone', () => {
    expect(form()).toMatch(/className="grid h-11 w-11 place-items-center rounded-lg"/);
    expect(form()).toMatch(/flex min-h-\[44px\] items-center gap-1\.5/);
    expect(form()).toMatch(/<Button onClick=\{submit\}[^>]*className="min-h-\[44px\] shrink-0">/);
    expect(form()).toMatch(/className="flex flex-wrap items-center/);
  });

  it('says what Meet again does and who sees the stars, once, above the rows', () => {
    expect(src()).toMatch(/You have unrated conversations\s*<\/h3>\s*\{\/\*[^*]*\*\/\}\s*<p[^>]*>\{MEET_AGAIN_HELP\} \{STARS_PRIVATE\}<\/p>/);
  });
});
