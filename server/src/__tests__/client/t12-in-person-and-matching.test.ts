// ─── In-person events and one Matching section on every type (30 Oct 2026, T12) ──────────────────
//
// "Physical (in-person) meeting", "Speed networking types, e.g. founders and investors, job-related" and "Matching
// rules should be available when creating an event". The Matching section is drawn here for each type (run, not read):
//   - Speed networking: "Who should meet whom" with the presets as one-line cards ("… first"), admins' "Other
//     templates…", then the rule's four options, the cooldown's months showing under that rule only;
//   - Video meeting and In person: the one line, and a button that switches to Speed networking through the picker;
// and the pages are pinned: the event page draws no Go Live or Enter Event for an in-person event, shows its place with
// a maps link, names the preset, and its duplicate sends the type; the live page sends an in-person event back.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MATCHING_PRESET_IDS } from '@rsn/shared';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

type Section = (props: Record<string, unknown>) => unknown;
const section = () => loadClientModule('features/sessions/MatchingSection.tsx', {
  'lucide-react': iconStandIns,
}) as { default: Section; NO_PAIRING_LINE: string; MATCHING_POLICIES: Array<{ value: string }> };

const unescape = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const words = (html: string) => unescape(html.replace(/<[^>]*>/g, '\n')).split('\n').map((w) => w.trim()).filter(Boolean);

const PRESETS = [
  { id: MATCHING_PRESET_IDS.general, name: 'General', description: 'A broad mix of people, with shared interests first' },
  { id: MATCHING_PRESET_IDS.foundersInvestors, name: 'Founders and investors', description: 'Founders meet investors first' },
  { id: MATCHING_PRESET_IDS.jobsHiring, name: 'Jobs and hiring', description: 'People hiring meet people looking for a role first' },
  { id: MATCHING_PRESET_IDS.mentorship, name: 'Mentorship', description: 'Mentors meet people looking for guidance first' },
];

function draw(over: Record<string, unknown> = {}): string {
  const { default: MatchingSection } = section();
  const register = (name: string) => ({ name, onChange: () => undefined, onBlur: () => undefined, ref: () => undefined });
  return renderToStaticMarkup(createElement(MatchingSection as never, {
    format: 'speed_networking', register, errors: {}, templateId: MATCHING_PRESET_IDS.general, policy: 'within_event',
    onTemplate: () => undefined, onTouched: () => undefined,
    presets: { data: PRESETS, isLoading: false, isError: false, retry: () => undefined },
    isAdmin: false, templates: [], templatesLoading: false,
    offered: ['video_meeting', 'speed_networking', 'physical_event'], onChooseFormat: () => undefined,
    ...over,
  } as never));
}

describe('the Matching section, for speed networking', () => {
  it('asks who should meet whom, with the four presets as one-line cards, General chosen', () => {
    const html = draw();
    const w = words(html);
    expect(w).toEqual(expect.arrayContaining(['Matching', 'Who should meet whom', 'Founders and investors', 'Founders meet investors first',
      'People hiring meet people looking for a role first']));
    expect(html).toMatch(new RegExp(`checked="" value="${MATCHING_PRESET_IDS.general}"`));
    expect(html).not.toContain('Other templates');
  });

  it('then the rule, with four options, the fourth the cooldown', () => {
    const { MATCHING_POLICIES } = section();
    expect(MATCHING_POLICIES.map((p) => p.value)).toEqual(['platform_wide', 'within_event', 'none', 'cooldown']);
    const w = words(draw());
    expect(w).toEqual(expect.arrayContaining(['Matching rule', 'Platform-wide no rematch', 'Within this event only', 'No restriction', 'Not again for a while']));
    expect(w).not.toContain('Months apart');
  });

  it('the months show under the cooldown rule, 1 to 60', () => {
    const html = draw({ policy: 'cooldown' });
    expect(words(html)).toEqual(expect.arrayContaining(['Months apart', '1 – 60 months']));
    expect(html).toMatch(/name="cooldownMonths"/);
  });

  it('an admin also gets Other templates…, and a template that is no preset shows as itself', () => {
    const tpl = '33333333-3333-4333-8333-333333333333';
    const html = draw({ isAdmin: true, templates: [{ id: tpl, name: 'Investor Day v2' }, { id: MATCHING_PRESET_IDS.general, name: 'General', isPreset: true }], templateId: tpl });
    expect(words(html)).toEqual(expect.arrayContaining(['Other templates…', 'Investor Day v2']));
    expect(html).toMatch(/checked="" value="other"/);
  });

  it('has a loading state, an error state with Try again, and an empty state', () => {
    expect(draw({ presets: { data: undefined, isLoading: true, isError: false, retry: () => undefined } })).toMatch(/aria-busy="true"/);
    expect(words(draw({ presets: { data: undefined, isLoading: false, isError: true, retry: () => undefined } })))
      .toEqual(expect.arrayContaining(['Try again']));
    expect(words(draw({ presets: { data: [], isLoading: false, isError: false, retry: () => undefined } })).join(' '))
      .toContain('No matching choices yet.');
  });
});

describe('the Matching section, for a type that pairs nobody', () => {
  it.each(['video_meeting', 'physical_event'])('%s: the one line, and a button to Speed networking', (format) => {
    const { NO_PAIRING_LINE } = section();
    expect(NO_PAIRING_LINE).toBe("Video meetings don't pair people. Choose Speed networking to match people one to one.");
    const w = words(draw({ format }));
    expect(w).toEqual(['Matching', NO_PAIRING_LINE, 'Choose Speed networking']);
  });

  it('no button where the pod holds no speed networking (a Chat pod)', () => {
    expect(words(draw({ format: 'video_meeting', offered: ['video_meeting'] }))).not.toContain('Choose Speed networking');
  });

  it('the button switches through the type picker (its confirm question), not around it', () => {
    for (const page of ['features/sessions/CreateSessionPage.tsx', 'features/sessions/EditEventModal.tsx']) {
      expect(readClientSource(page)).toMatch(/onChooseFormat: ev\.chooseFormat/);
    }
    expect(readClientSource('features/sessions/useEventFormatForm.ts')).toMatch(/\n    chooseFormat,\n/);
  });
});

describe('the forms', () => {
  it('draw the Where field for a type with a place: 44px, at most 300 characters, its error at the field', () => {
    const fields = readClientSource('features/sessions/EventFormatFields.tsx');
    expect(fields).toMatch(/\{fields\.location && \(/);
    expect(fields).toMatch(/maxLength=\{fields\.location\.maxLength\}/);
    expect(fields).toMatch(/className=\{cn\(EVENT_FIELD, fieldBorder\(err\('location'\)\)/);
    expect(fields).toMatch(/error=\{err\('location'\)\}/);
    expect(fields).toMatch(/The event ends itself when this time is up\./);
  });

  it('the create form starts a Two-Sided Networking pod on Founders and investors, unless the organiser chose', () => {
    const page = readClientSource('features/sessions/CreateSessionPage.tsx');
    expect(page).toMatch(/if \(podType && !ev\.touched\('matchingTemplateId'\)\) setValue\('matchingTemplateId', startingPreset\(podType\)\);/);
  });
});

describe('the event page and the live page', () => {
  const page = readClientSource('features/sessions/SessionDetailPage.tsx');
  const live = readClientSource('features/live/LiveSessionPage.tsx');

  it('an in-person event has no Go Live, Enter Event or Enter Live Event', () => {
    expect(page).toMatch(/const hasRoom = liveKindOf\(eventFormat\) !== 'none';/);
    expect(page).toMatch(/\{hasRoom && \(isRegistered \|\| isHost\) && sessionStatusPhase\(session\.status\) === 'pre' && \(/);
    expect(page).toMatch(/\{hasRoom && \(isRegistered \|\| isHost\) && sessionStatusPhase\(session\.status\) === 'live' && \(/);
  });

  it('shows the place with Open in maps (44px), and after the event Who took part', () => {
    expect(page).toMatch(/\{place && <EventPlace place=\{place\} over=\{phase === 'done'\} \/>\}/);
    const place = readClientSource('features/sessions/EventPlace.tsx');
    expect(place).toMatch(/href=\{mapsUrl\(place\)\}/);
    expect(place).toMatch(/min-h-\[44px\][^"]*"\n\s*>\n\s*Open in maps/);
    expect(place).toMatch(/\[overflow-wrap:anywhere\]/);
    expect(page).toMatch(/\{isRoundsEvent \? 'View recap' : 'Who took part'\}/);
  });

  it("passes the place to T7's calendar entry, for the menu's links and the file alike", () => {
    expect(page.match(/pageUrl: `\$\{window\.location\.origin\}\/sessions\/\$\{session\.id\}`,\n\s*place,\n/g)).toHaveLength(2);
  });

  it('names the preset on the facts line', () => {
    expect(page).toMatch(/eventFactsLine\(eventFormat, session\.config, presetNameOf\(session\.config, presets\)\)/);
    expect(page).toMatch(/const \{ data: presets \} = useMatchingPresets\(\);/);
  });

  it('the duplicate sends the type (D9)', () => {
    expect(page).toMatch(/format: session \? resolveEventFormat\(session\) : undefined,\n\s*config: session\?\.config,/);
  });

  it('the live page sends an in-person event back to its page before the room asks for the camera', () => {
    const gate = live.slice(live.indexOf('export default function LiveSessionPage()'), live.indexOf('function LiveEventRoom()'));
    expect(gate).toMatch(/=== 'none'\) return <Navigate to=\{`\/sessions\/\$\{sessionId\}`\} replace \/>/);
    expect(gate).not.toMatch(/getUserMedia|useSessionSocket/);
    expect(gate).toMatch(/meta: \{ entities: sessionId \? \[E\.session\(sessionId\)\] : \[\] \}/);
  });
});
