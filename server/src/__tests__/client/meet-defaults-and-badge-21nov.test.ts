// ─── 21 Nov 2026: a member's standard meeting request, and the admin-given Premium badge ─────────────────────────
//
// Stefan: "I should be able in my profile to state my 'standard message' and preferred format". Edit profile has a
// "Your meeting request" form; the Meet sheet opens on the saved note made out to the person ({first} becomes their
// first name) and the saved format, and never sends an unreplaced {first}. Shradha: "can we update a premium badge to
// them?" An admin gives or takes away the badge from the Users page (a row, or the selection); it is drawn beside the
// member's name on Everyone, Your connections, search, For You cards and the profile hero. Drawn to markup where a
// component can be drawn; read as source where the thing to pin is the wiring.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

type Note = {
  defaultMeetNote: (name: string | null | undefined) => string;
  fillFirstName: (note: string, name: string | null | undefined) => string;
  startingMeetNote: (saved: string | null | undefined, name: string | null | undefined) => string;
  FIRST_NAME_TOKEN: string;
  MEET_NOTE_EXAMPLE: string;
};
const note = () => loadClientModule('features/reason/human/meet-note.ts', {}) as Note;
const REASON_NOTE = (first: string) => `Hi ${first}, I think we have a good reason to talk. Would you be up for a short call to compare notes?`;

describe('the standard message: {first} becomes the person\'s first name', () => {
  it('fills every {first}, however it is written, with the first word of the name', () => {
    const { fillFirstName } = note();
    expect(fillFirstName('Hi {first}, are you free? Thanks {first}!', 'Shradha Adhikari')).toBe('Hi Shradha, are you free? Thanks Shradha!');
    expect(fillFirstName('Hi {First}, and { first }.', '  Stefan  Avivson ')).toBe('Hi Stefan, and Stefan.');
    // A name is put in as it is, never read as a replacement pattern.
    expect(fillFirstName('Hi {first}', '$& $1')).toBe('Hi $&');
  });

  it('with no name to greet, "Hi {first}," reads "Hi," and any other {first} reads "there": never the token', () => {
    const { fillFirstName } = note();
    for (const name of [null, undefined, '', '  ', 'Member']) {
      expect(fillFirstName('Hi {first}, shall we talk?', name)).toBe('Hi, shall we talk?');
      expect(fillFirstName('{first}, shall we talk?', name)).toBe('there, shall we talk?');
      expect(fillFirstName('Dear {first}\nsee you', name)).not.toMatch(/\{\s*first\s*\}/i);
    }
  });

  it('the sheet starts from the saved note made out to the person, or REASON\'s own when none is saved', () => {
    const { startingMeetNote } = note();
    expect(startingMeetNote('Hi {first}, my own words.', 'Claus Berg')).toBe('Hi Claus, my own words.');
    for (const none of [null, undefined, '', '   ']) expect(startingMeetNote(none, 'Claus Berg')).toBe(REASON_NOTE('Claus'));
  });

  it('the profile form\'s example is REASON\'s own note written with the token', () => {
    const { MEET_NOTE_EXAMPLE, FIRST_NAME_TOKEN } = note();
    expect(FIRST_NAME_TOKEN).toBe('{first}');
    expect(MEET_NOTE_EXAMPLE).toBe(REASON_NOTE('{first}'));
  });
});

describe('the Meet sheet opens on the member\'s saved request', () => {
  const toastStore = { useToastStore: (sel?: (s: { addToast: () => void }) => unknown) => {
    const state = { addToast: () => undefined };
    return sel ? sel(state) : state;
  } };
  let mutated: unknown[] = [];
  const sheet = (saved: { note: string | null; format: string | null } | undefined) => loadClientModule('features/reason/human/MeetSheet.tsx', {
    '@tanstack/react-query': {
      useQueryClient: () => ({ invalidateQueries: () => undefined }),
      useMutation: () => ({ mutate: (v: unknown) => { mutated.push(v); }, isPending: false, variables: undefined }),
    },
    '@/lib/utils': { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') },
    '@/stores/toastStore': toastStore,
    '../ui/Sheet': {
      __esModule: true,
      default: ({ open, children, footer }: { open: boolean; children?: ReactNode; footer?: ReactNode }) => (open ? createElement('div', null, children, footer) : null),
    },
    '../api': { errorMessage: () => '', reasonKeys: { all: ['reason'] }, sendMeetRequest: () => Promise.resolve() },
    './useMeetDefaults': { useMeetDefaults: () => ({ data: saved }) },
  }).default as (props: Record<string, unknown>) => JSX.Element;
  const draw = (saved: { note: string | null; format: string | null } | undefined, displayName = 'Shradha Adhikari') =>
    renderToStaticMarkup(createElement(sheet(saved), { person: { userId: 'u1', displayName }, onClose: () => undefined }));

  it('a saved note with {first} is shown made out to the person, and a saved format is the one chosen', () => {
    const html = draw({ note: 'Hi {first}, loved your talk. Coffee?', format: 'coffee' });
    expect(html).toMatch(/<textarea[^>]*>Hi Shradha, loved your talk\. Coffee\?<\/textarea>/);
    expect(html).toMatch(/<option value="coffee" selected="">In person coffee<\/option>/);
    expect(html).toContain('36 / 300');
  });

  it('none saved (or not read yet): REASON\'s own note and the 20 minute video conversation', () => {
    for (const saved of [{ note: null, format: null }, undefined]) {
      const html = draw(saved);
      expect(html).toContain(`>${REASON_NOTE('Shradha')}</textarea>`);
      expect(html).toMatch(/<option value="video_20" selected="">20 minute video conversation<\/option>/);
    }
  });

  it('sends the note with any {first} made out, so nobody ever reads "{first}"', () => {
    const src = readClientSource('features/reason/human/MeetSheet.tsx').replace(/\s+/g, ' ');
    expect(src).toContain("import { fillFirstName, startingMeetNote } from './meet-note';");
    expect(src).toContain('const sent = fillFirstName(note, person?.displayName).trim();');
    expect(src).toContain('send.mutate({ userId: person.userId, displayName: person.displayName, note: sent, format });');
  });
});

describe('the saved request is the member\'s own row, read live', () => {
  it('reads GET /users/me under user:<them>, the tag a save on any of their devices sends', () => {
    const hook = readClientSource('features/reason/human/useMeetDefaults.ts');
    expect(hook).toMatch(/api\.get\('\/users\/me'\)/);
    expect(hook).toMatch(/meta: \{ entities: userId \? \[E\.user\(userId\)\] : \[\] \}/);
    expect(hook).toMatch(/note: me\.meetNoteDefault \?\? null, format: me\.meetFormatDefault \?\? null/);
  });
});

type Form = {
  meetRequestSchema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: string[]; message: string }> } } };
  meetRequestValues: (saved: unknown) => { note: string; format: string };
  meetRequestBody: (v: { note: string; format: string }) => unknown;
  meetRequestFieldError: (err: unknown) => unknown;
  MEET_NOTE_TOO_LONG: string;
};
const form = () => loadClientModule('features/profile/meet-request-form.ts', {}) as Form;

describe('the "Your meeting request" form\'s rules', () => {
  it('takes up to 300 characters (spaces round it not counted) and says the limit past it', () => {
    const { meetRequestSchema, MEET_NOTE_TOO_LONG } = form();
    expect(meetRequestSchema.safeParse({ note: 'a'.repeat(300), format: 'video_20' }).success).toBe(true);
    expect(meetRequestSchema.safeParse({ note: `  ${'a'.repeat(300)}  `, format: 'coffee' }).success).toBe(true);
    expect(meetRequestSchema.safeParse({ note: '', format: 'message_first' }).success).toBe(true);
    const long = meetRequestSchema.safeParse({ note: 'a'.repeat(301), format: 'video_20' });
    expect(long.success).toBe(false);
    expect(long.error!.issues[0]).toMatchObject({ path: ['note'], message: MEET_NOTE_TOO_LONG });
    expect(MEET_NOTE_TOO_LONG).toBe('Keep the message to 300 characters or fewer.');
    expect(meetRequestSchema.safeParse({ note: '', format: 'phone' }).error!.issues[0]).toMatchObject({ path: ['format'], message: 'Choose one of the offered formats.' });
  });

  it('opens on what is saved, and a save sends the note trimmed, an emptied box clearing it', () => {
    const { meetRequestValues, meetRequestBody } = form();
    expect(meetRequestValues(undefined)).toEqual({ note: '', format: 'video_20' });
    expect(meetRequestValues({ note: null, format: null })).toEqual({ note: '', format: 'video_20' });
    expect(meetRequestValues({ note: 'Hi {first}', format: 'coffee' })).toEqual({ note: 'Hi {first}', format: 'coffee' });
    expect(meetRequestBody({ note: '  Hi {first}  ', format: 'coffee' })).toEqual({ meetNoteDefault: 'Hi {first}', meetFormatDefault: 'coffee' });
    expect(meetRequestBody({ note: '   ', format: 'video_20' })).toEqual({ meetNoteDefault: null, meetFormatDefault: 'video_20' });
  });

  it('the server\'s refusal of a field is said under that field', () => {
    const { meetRequestFieldError } = form();
    const refusal = (details: unknown) => ({ response: { status: 400, data: { error: { message: 'Validation failed', details } } } });
    expect(meetRequestFieldError(refusal({ meetNoteDefault: ['Keep the message to 300 characters or fewer.'] })))
      .toEqual({ field: 'note', message: 'Keep the message to 300 characters or fewer.' });
    expect(meetRequestFieldError(refusal({ meetFormatDefault: ['Choose one of the offered formats.'] })))
      .toEqual({ field: 'format', message: 'Choose one of the offered formats.' });
    expect(meetRequestFieldError(refusal({ bio: ['x'] }))).toBeNull();
    expect(meetRequestFieldError(new Error('Network Error'))).toBeNull();
  });
});

describe('the "Your meeting request" section on Edit profile', () => {
  const stand = (data: unknown, extra: Record<string, unknown> = {}) => ({
    '@tanstack/react-query': {
      useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
      useMutation: () => ({ mutate: () => undefined, isPending: false }),
    },
    'lucide-react': iconStandIns,
    '@/components/ui/Card': { __esModule: true, default: ({ children, ...rest }: { children?: ReactNode }) => createElement('section', rest, children) },
    '@/components/ui/Button': { Button: ({ children, isLoading: _l, ...rest }: { children?: ReactNode; isLoading?: boolean }) => createElement('button', rest, children) },
    '@/components/ui/Spinner': { Skeleton: () => createElement('div', { 'data-skeleton': true }) },
    '@/lib/api': { __esModule: true, default: { put: () => Promise.resolve() } },
    '@/stores/authStore': { useAuthStore: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: 'u-me' } }) },
    '@/stores/toastStore': { useToastStore: (sel: (s: { addToast: () => void }) => unknown) => sel({ addToast: () => undefined }) },
    '@/features/reason/errors': { errorMessage: () => '' },
    '@/features/reason/human/useMeetDefaults': { meetDefaultsKey: (id: string) => ['meet-defaults', id], useMeetDefaults: () => data },
    ...extra,
  });
  const draw = (data: unknown) => {
    const Section = loadClientModule('features/profile/MeetRequestSection.tsx', stand(data)).default as () => JSX.Element;
    return renderToStaticMarkup(createElement(Section));
  };

  it('while it loads: a skeleton, said to a screen reader; when it fails: the words and Try again', () => {
    const loading = draw({ isPending: true, isError: false, data: undefined, refetch: () => undefined });
    expect(loading).toContain('Loading your meeting request');
    expect(loading).toContain('data-skeleton');
    expect(loading).not.toContain('<textarea');
    const failed = draw({ isPending: false, isError: true, data: undefined, refetch: () => undefined });
    expect(failed).toContain('We could not load your meeting request just now.');
    expect(failed).toContain('Try again');
  });

  it('loaded: the message box with its 300 counter and the {first} hint, the format menu, and a Save that waits for a change', () => {
    const html = draw({ isPending: false, isError: false, data: { note: null, format: null }, refetch: () => undefined });
    expect(html).toContain('Your meeting request');
    expect(html).toMatch(/<textarea[^>]*placeholder="Hi \{first\}, I think we have a good reason to talk\./);
    expect(html).toContain('0 / 300');
    expect(html).toContain('the person&#x27;s first name should go');
    expect(html).toContain('Leave it empty to use REASON&#x27;s own message.');
    expect(html).toContain('Start from REASON&#x27;s message');
    for (const label of ['20 minute video conversation', 'In person coffee', 'Message first']) expect(html).toContain(`>${label}</option>`);
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*data-testid="meet-request-save"[^>]*>Save meeting request<\/button>/);
    // Every control is at least 44px tall.
    expect(html).toMatch(/<select[^>]*class="[^"]*min-h-\[44px\]/);
    expect(html).toMatch(/<button type="button" class="[^"]*min-h-\[44px\][^"]*">Start from REASON/);
  });

  it('is a react-hook-form form with the Zod resolver, saving only these two fields, its Save busy until they are read back', () => {
    const src = readClientSource('features/profile/MeetRequestSection.tsx').replace(/\s+/g, ' ');
    expect(src).toContain('useForm<MeetRequestValues>({ defaultValues: meetRequestValues(undefined), resolver: formResolver(meetRequestSchema) })');
    expect(src).toContain("mutationFn: (values: MeetRequestValues) => api.put('/users/me', meetRequestBody(values))");
    expect(src).toContain('return qc.invalidateQueries({ queryKey: meetDefaultsKey(userId) });');
    expect(src).toContain('if (field) setError(field.field, { type: \'server\', message: field.message }, { shouldFocus: true });');
    expect(src).toContain('isLoading={save.isPending} disabled={!isDirty || over}');
    // An unsaved edit is never put back by a refetch.
    expect(src).toContain('if (data && !form.formState.isDirty) reset(meetRequestValues(data));');
  });

  it('sits on Edit profile, after the profile form (its own form, so it is not nested in it)', () => {
    const page = readClientSource('features/profile/ProfilePage.tsx');
    expect(page).toContain("import MeetRequestSection from './MeetRequestSection';");
    expect(page.indexOf('</form>')).toBeLessThan(page.indexOf('<MeetRequestSection />'));
  });
});

describe('the Premium badge', () => {
  const badge = () => loadClientModule('components/ui/ProfileBadge.tsx', { 'lucide-react': iconStandIns }) as {
    default: (p: { badge?: string | null; size?: 'sm' | 'md' }) => JSX.Element | null;
    profileBadgeLabel: (b: string | null | undefined) => string | null;
  };

  it('draws "Premium" for premium and nothing for none or a value this build does not know', () => {
    const { default: Badge, profileBadgeLabel } = badge();
    const html = renderToStaticMarkup(createElement(Badge, { badge: 'premium' }));
    expect(html).toContain('data-testid="profile-badge"');
    expect(html).toContain('title="Premium member"');
    expect(html).toMatch(/>Premium<\/span>$/);
    for (const none of [null, undefined, '', 'gold', 'toString', 'constructor', '__proto__']) {
      expect({ none, html: renderToStaticMarkup(createElement(Badge, { badge: none })) }).toEqual({ none, html: '' });
      expect(profileBadgeLabel(none)).toBeNull();
    }
    expect(renderToStaticMarkup(createElement(Badge, { badge: 'premium', size: 'md' }))).toContain('text-[12px]');
  });

  it('is drawn beside the name on Everyone, Your connections, search, the For You card and the profile heroes', () => {
    const sites: Array<[string, string]> = [
      ['features/reason/people/EveryoneCard.tsx', '<ProfileBadge badge={person.profileBadge} className="ml-1.5" />'],
      ['features/reason/people/ConnectionCard.tsx', '<ProfileBadge badge={person.profileBadge} className="ml-1.5" />'],
      ['features/search/SearchPage.tsx', '<ProfileBadge badge={r.profileBadge} className="ml-1.5" />'],
      ['features/reason/human/HumanCard.tsx', '<ProfileBadge badge={person.profileBadge} className="ml-1.5" />'],
      ['features/reason/human/ProfileHero.tsx', '<ProfileBadge badge={profileBadge} size="md" className="mt-2.5" />'],
      ['features/reason/human/ProfileHero.tsx', 'profileBadge={brief.person.profileBadge}'],
      ['features/reason/profile/YourProfilePage.tsx', 'profileBadge={card.data.profileBadge}'],
    ];
    for (const [file, line] of sites) expect({ file, has: readClientSource(file).includes(line) }).toEqual({ file, has: true });
    // Inside the heading, right after the name's link, so it reads as part of who they are.
    expect(readClientSource('features/reason/people/EveryoneCard.tsx').replace(/\s+/g, ' '))
      .toMatch(/<Link to=\{profileUrl\} className="hover:underline">\{name\}<\/Link> \{\/\*[^*]*\*\/\} <ProfileBadge[^>]*\/> <\/h3>/);
    expect(readClientSource('features/reason/human/HumanCard.tsx')).toMatch(/profileBadge\?: string \| null;/);
  });
});

describe('the admin Users page gives and takes away the badge', () => {
  const hook = () => loadClientModule('features/admin/users/useProfileBadge.ts', {
    '@tanstack/react-query': { useMutation: () => ({}), useQueryClient: () => ({}) },
    '@/lib/api': { __esModule: true, default: {} },
    '@/stores/toastStore': { useToastStore: () => () => undefined },
  }) as { badgeDoneText: (c: { userIds: string[]; badge: 'premium' | null; name: string | null }) => string };

  it('says how it went in a sentence, for one row and for a selection', () => {
    const { badgeDoneText } = hook();
    expect(badgeDoneText({ userIds: ['a'], badge: 'premium', name: 'Ana Silva' })).toBe('Ana Silva has the Premium badge now.');
    expect(badgeDoneText({ userIds: ['a'], badge: null, name: 'Ana Silva' })).toBe('The Premium badge was taken off Ana Silva.');
    expect(badgeDoneText({ userIds: ['a', 'b', 'c'], badge: 'premium', name: null })).toBe('3 people have the Premium badge now.');
    expect(badgeDoneText({ userIds: ['a'], badge: 'premium', name: null })).toBe('1 person has the Premium badge now.');
    expect(badgeDoneText({ userIds: ['a', 'b'], badge: null, name: null })).toBe('The Premium badge was taken off 2 people.');
  });

  it('calls its own route, never the is_premium flag, and refetches the list after any answer', () => {
    const src = readClientSource('features/admin/users/useProfileBadge.ts');
    expect(src).toContain("api.put('/admin/users/profile-badge', { userIds, badge })");
    expect(src.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/is_premium|isPremium/);
    expect(src).toContain("onError: (err) => addToast(failureText(err), 'error')");
    expect(src).toMatch(/invalidateQueries\(\{ queryKey: \['admin-users'\] \}\)/);
  });

  it('each row, the admin\'s own too, has a 44px button that says what it will do, and the badge beside the name', () => {
    const Row = loadClientModule('features/admin/users/AdminUserRow.tsx', {
      'react-router-dom': { Link: ({ children }: { children?: ReactNode }) => createElement('a', null, children) },
      'lucide-react': iconStandIns,
    }).default as (p: Record<string, unknown>) => JSX.Element;
    const row = (profileBadge: string | null, isSelf: boolean) => renderToStaticMarkup(createElement(Row, {
      user: { id: 'u1', email: 'ana@example.com', displayName: 'Ana Silva', avatarUrl: null, role: 'member', status: 'active', profileBadge },
      tab: 'active', isSelf, isSuperAdmin: false, selected: false, busy: false, roleBusy: false, badgeBusy: false,
      onToggleSelect: () => undefined, onAction: () => undefined, onRole: () => undefined, onLimits: () => undefined, onBadge: () => undefined,
    }));
    const give = row(null, false);
    expect(give).toMatch(/<button type="button" aria-label="Give Ana Silva the Premium badge" data-testid="admin-user-badge-u1" class="[^"]*min-h-\[44px\]/);
    expect(give).toContain('Give Premium badge');
    expect(give).not.toContain('data-testid="profile-badge"');
    const remove = row('premium', true);
    expect(remove).toContain('aria-label="Take the Premium badge off Ana Silva"');
    expect(remove).toContain('Remove Premium badge');
    expect(remove).toContain('data-testid="profile-badge"');
    // The admin's own row offers the badge and nothing else.
    expect(remove).not.toContain('Limits');
  });

  it('the bulk bar gives or takes it from the selection, asking first, one change at a time', () => {
    const bar = readClientSource('features/admin/users/UsersBulkBar.tsx');
    expect(bar).toContain("onClick={() => setBadgeAsk({ badge: 'premium' })}>Give Premium badge</button>");
    expect(bar).toContain('onClick={() => setBadgeAsk({ badge: null })}>Remove badge</button>');
    expect(bar).toContain('const working = mutation.isPending || badge.pending;');
    expect(bar).toMatch(/busy=\{badge\.pending\}/);
    expect(bar).toContain('badge.change({ userIds: selected, badge: badgeAsk.badge, name: null })');
    const page = readClientSource('features/admin/AdminUsersPage.tsx');
    expect(page).toContain('onBadge={(next) => badge.change({ userIds: [u.id], badge: next, name: nameOf(u) })}');
  });
});
