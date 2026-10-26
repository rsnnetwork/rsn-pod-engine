// ─── L3 (25 Oct feedback, production's own client): the create forms follow the pod type and the event format ──
//
// Stefan and Claus, on app.rsn.network: choosing a Reason pod left Orchestration on Timed Rounds, so they set
// Free Form by hand ("orchestration should follow the pod type"); and scheduling a Video Meeting showed the rounds
// card, with 5 rounds of 8 minutes ("there's no timing configuration for a video meeting"). POD-01, POD-03.
//
// The shared pod-type and event-format tables now say what follows what (shared/src/events). These pins check that
// production's two create forms read them: the pod form starts on its type's orchestration, offers only the modes
// the type allows and says so when a type change replaces a choice; the event form offers only the formats the pod's
// type holds, describes the one chosen, shows round settings only for a rounds format, a length for a meeting, and
// posts the format at the top of the body. The two forms are drawn to markup here with their data stood in; what
// they look like and do in a browser is checked in a browser (headed, Chromium and WebKit).

import { createElement, forwardRef, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadClientModule, readClientSource, iconStandIns } from './load-client-module';

const POD_MODAL = 'features/pods/CreatePodModal.tsx';
const POD_FORM = 'features/pods/pod-form.ts';
const SESSION_PAGE = 'features/sessions/CreateSessionPage.tsx';
const EVENT_FORM = 'features/sessions/event-form.ts';
const EVENT_HOOK = 'features/sessions/useEventFormat.ts';

/** Markup as a person reads it: the escapes React writes put back. */
const unescape = (text: string): string => text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
/** What a person reads in some markup: tags taken out, one text node per entry. */
const words = (html: string): string[] => unescape(html.replace(/<[^>]*>/g, '\n')).split('\n').map((s) => s.trim()).filter(Boolean);
/** The visible texts of the options of the select that starts with `selectMarker`. */
const optionsOf = (html: string, selectMarker: string): string[] => {
  const from = html.indexOf(selectMarker);
  if (from < 0) return [];
  const select = html.slice(from, html.indexOf('</select>', from));
  return [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => unescape(m[1]));
};

// ── The pod form's rules, run ──────────────────────────────────────────────────────────────────────────
describe('L3 - the pod form follows the pod type (pod-form.ts)', () => {
  interface PodFormValues {
    name: string; description: string; podType: string; orchestrationMode: string; communicationMode: string;
    visibility: string; maxMembers: number | ''; allowMemberInvites?: boolean;
  }
  interface PodFormModule {
    startingPodForm: (initial?: Partial<PodFormValues>) => { values: PodFormValues; notices: string[]; chosen: Set<string> };
    afterTypeChange: (current: PodFormValues, nextType: string, chosen: ReadonlySet<string>) => {
      values: Pick<PodFormValues, 'podType' | 'orchestrationMode' | 'communicationMode'>; notices: string[]; chosen: Set<string>;
    };
    orchestrationOptions: (podType: string) => Array<{ value: string; label: string }>;
    orchestrationLine: (mode: string) => string;
  }
  const form = (): PodFormModule => loadClientModule(POD_FORM, {}) as unknown as PodFormModule;

  it('starts as a speed-networking pod on that type\'s own orchestration and communication, with nothing said', () => {
    const { values, notices, chosen } = form().startingPodForm();
    expect(values).toMatchObject({ podType: 'speed_networking', orchestrationMode: 'timed_rounds', communicationMode: 'video', visibility: 'private' });
    expect(notices).toEqual([]);
    expect(chosen.size).toBe(0);
  });

  it('choosing a Reason pod sets Freeform, without touching Orchestration', () => {
    const { startingPodForm, afterTypeChange } = form();
    const { values } = startingPodForm();
    const next = afterTypeChange(values, 'reason', new Set());
    expect(next.values).toEqual({ podType: 'reason', orchestrationMode: 'free_form', communicationMode: 'video' });
    expect(next.notices).toEqual([]);
  });

  it('each type brings its own communication: a Chat pod is text, a Physical Event hybrid, so no one sets it by hand', () => {
    const { startingPodForm, afterTypeChange } = form();
    const { values } = startingPodForm();
    expect(afterTypeChange(values, 'chat', new Set()).values.communicationMode).toBe('text');
    expect(afterTypeChange(values, 'physical_event', new Set()).values.communicationMode).toBe('hybrid');
  });

  it('a mode the member chose stays while the new type allows it, and is replaced WITH A NOTICE when it does not', () => {
    const { startingPodForm, afterTypeChange } = form();
    const { values } = startingPodForm();
    const chosen = new Set(['orchestrationMode']);
    // Moderated, chosen on a Reason pod, is fine on a Conversational pod...
    const reason = { ...values, podType: 'reason', orchestrationMode: 'moderated' };
    const kept = afterTypeChange(reason, 'conversational', chosen);
    expect(kept).toEqual({
      values: { podType: 'conversational', orchestrationMode: 'moderated', communicationMode: 'video' }, notices: [],
      chosen: new Set(['orchestrationMode']),
    });
    // ...but not on a Speed Networking pod, which runs on timed rounds only: the member is told, not left guessing.
    const back = afterTypeChange(reason, 'speed_networking', chosen);
    expect(back.values.orchestrationMode).toBe('timed_rounds');
    expect(back.notices).toHaveLength(1);
    expect(back.notices[0]).toMatch(/^Changed to Timed rounds: /);
  });

  it('once a type change has replaced what the member chose, that choice is gone: going back is silent, not noticed twice', () => {
    const { startingPodForm, afterTypeChange } = form();
    const { values } = startingPodForm();
    // Moderated, chosen on Reason...
    const onReason = { ...values, podType: 'reason', orchestrationMode: 'moderated' };
    // ...replaced by timed rounds when the pod becomes Speed Networking, with the notice...
    const toSpeed = afterTypeChange(onReason, 'speed_networking', new Set(['orchestrationMode']));
    expect(toSpeed.values.orchestrationMode).toBe('timed_rounds');
    expect(toSpeed.notices).toHaveLength(1);
    expect(toSpeed.chosen.has('orchestrationMode')).toBe(false);
    // ...is not a choice to be replaced again, and noticed again, on the way back to Reason.
    const back = afterTypeChange({ ...onReason, ...toSpeed.values }, 'reason', toSpeed.chosen);
    expect(back.values).toEqual({ podType: 'reason', orchestrationMode: 'free_form', communicationMode: 'video' });
    expect(back.notices).toEqual([]);
  });

  it('a duplicate of an old Reason pod saved on timed rounds reads as Freeform, with the notice, and keeps its communication', () => {
    const { startingPodForm } = form();
    const { values, notices } = startingPodForm({ name: 'Copy', podType: 'reason', orchestrationMode: 'timed_rounds', communicationMode: 'hybrid' });
    expect(values).toMatchObject({ name: 'Copy', podType: 'reason', orchestrationMode: 'free_form', communicationMode: 'hybrid' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Changed to Freeform: Reason pods don't use timed rounds\.$/);
  });

  it('a duplicate starts as a copy, but once its type changes its communication is the new type\'s: nobody can choose it here', () => {
    const { startingPodForm, afterTypeChange } = form();
    // A copy of a Chat pod starts with its source's communication...
    const { values, chosen } = startingPodForm({ name: 'Copy', podType: 'chat', orchestrationMode: 'free_form', communicationMode: 'text' });
    expect(values.communicationMode).toBe('text');
    // ...and as a Reason pod it is by video, not text carried over from a control that is gone.
    const asReason = afterTypeChange(values, 'reason', chosen);
    expect(asReason.values).toEqual({ podType: 'reason', orchestrationMode: 'free_form', communicationMode: 'video' });
    expect(asReason.chosen.has('communicationMode')).toBe(false);
    // And on to a Physical Event: hybrid.
    expect(afterTypeChange({ ...values, ...asReason.values }, 'physical_event', asReason.chosen).values.communicationMode).toBe('hybrid');
  });

  it('offers only the modes the type allows: Reason has Freeform and Moderated, Speed Networking has timed rounds alone', () => {
    const { orchestrationOptions, orchestrationLine } = form();
    expect(orchestrationOptions('reason')).toEqual([
      { value: 'free_form', label: 'Freeform' }, { value: 'moderated', label: 'Moderated' },
    ]);
    expect(orchestrationOptions('speed_networking')).toEqual([{ value: 'timed_rounds', label: 'Timed rounds' }]);
    expect(orchestrationLine('free_form')).toBe('Events in this pod run as Freeform: everyone together in one room.');
  });
});

// ── The pod form, drawn ────────────────────────────────────────────────────────────────────────────────
describe('L3 - CreatePodModal reads the shared tables and no longer carries speed-networking defaults', () => {
  const src = readClientSource(POD_MODAL);

  function drawModal(initial?: Record<string, unknown>): string {
    const mod = loadClientModule(POD_MODAL, {
      '@tanstack/react-query': { useMutation: () => ({ mutate: () => undefined, isPending: false }), useQueryClient: () => ({ invalidateQueries: () => undefined }) },
      'react-router-dom': { useNavigate: () => () => undefined },
      '@/components/ui/Modal': { __esModule: true, default: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? createElement('div', null, children) : null) },
      '@/components/ui/Input': {
        __esModule: true,
        default: forwardRef<HTMLInputElement, { label?: string }>(({ label, ...props }, ref) => createElement('div', null, label ? createElement('label', null, label) : null, createElement('input', { ref, ...props }))),
      },
      '@/components/ui/Button': { Button: ({ children }: { children?: ReactNode }) => createElement('button', null, children) },
      '@/stores/toastStore': { useToastStore: () => ({ addToast: () => undefined }) },
      '@/lib/api': { __esModule: true, default: { post: () => undefined } },
    });
    return renderToStaticMarkup(createElement(mod.default as ComponentType<{ open: boolean; onClose: () => void; initialValues?: Record<string, unknown> }>, { open: true, onClose: () => undefined, initialValues: initial }));
  }

  it('has no literal timed_rounds, free_form or moderated: the defaults and the options come from the shared definition', () => {
    expect(src).not.toMatch(/['"]timed_rounds['"]|['"]free_form['"]|['"]moderated['"]/);
    expect(readClientSource(POD_FORM)).not.toMatch(/['"]timed_rounds['"]|['"]free_form['"]|['"]moderated['"]/);
    expect(src).toMatch(/from '@rsn\/shared'/);
    expect(src).toMatch(/\bPOD_TYPES\b/);
    expect(readClientSource(POD_FORM)).toMatch(/\bapplyTypeChange\b/);
    expect(readClientSource(POD_FORM)).toMatch(/\.orchestration\.allowed/);
  });

  it('a type change runs the shared rule and sets the orchestration and communication from it', () => {
    expect(src).toMatch(/afterTypeChange\(/);
    expect(src).toMatch(/setValue\('orchestrationMode'/);
    expect(src).toMatch(/setValue\('communicationMode'/);
    expect(src).toMatch(/register\('podType', \{ onChange:/);
  });

  it('there is no Communication select: it is the type\'s, and nobody sets it by hand', () => {
    const html = drawModal();
    expect(words(html)).not.toContain('Communication');
    expect(src).not.toMatch(/register\('communicationMode'/);
  });

  it('a new pod: Speed Networking, and its one mode is said in a line, not offered as a pick', () => {
    const html = drawModal();
    expect(html).toContain('data-testid="pod-orchestration"');
    expect(words(html)).toContain('Events in this pod run as Timed rounds: timed one-to-one rounds with automatic matching.');
    expect(optionsOf(html, 'name="orchestrationMode"')).toEqual([]);
  });

  it('a Reason pod offers Freeform and Moderated to pick from, and a duplicate of an old Reason pod on timed rounds says it was changed', () => {
    const html = drawModal({ podType: 'reason', orchestrationMode: 'timed_rounds', name: 'Copy' });
    expect(html).not.toContain('data-testid="pod-orchestration"');
    expect(optionsOf(html, '<select data-testid="pod-orchestration-select"')).toEqual(['Freeform', 'Moderated']);
    expect(words(html)).toContain("Changed to Freeform: Reason pods don't use timed rounds.");
  });

  it('the pod types are the shared table\'s, labelled with its one-line summary', () => {
    const options = optionsOf(drawModal(), '<select name="podType"');
    expect(options).toContain('Reason Pod — A small group (5 to 12) that meets for depth around a shared purpose');
    expect(options).toHaveLength(8);
  });

  it('is reset when it closes, never as it opens: a reset then can land after the first thing typed and wipe it', () => {
    // The form used to reset on open. Typing at once, a name was lost 2 times in 20 (the Required error then stopped
    // the save), because the reset runs a moment after the form is on screen.
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(open\) return;/);
    expect(src).not.toMatch(/if \(open\) \{\s*chosen\.current/);
    expect(src).toMatch(/\}, \[open, start, reset\]\);/);
  });

  it('starts from the CONTENT of the pod to copy, not from the object: the pod page builds a new one each time it draws', () => {
    expect(src).toMatch(/const initialKey = JSON\.stringify\(initialValues \?\? null\);/);
    expect(src).toMatch(/useMemo\(\(\) => startingPodForm\(JSON\.parse\(initialKey\) \?\? undefined\), \[initialKey\]\)/);
  });

  it('keeps what a type change returns as chosen, so the form carries on from it', () => {
    expect(src).toMatch(/chosen\.current = next\.chosen;/);
  });

  it('on a phone nothing sits two to a row: visibility and capacity stack, and are side by side only from sm up', () => {
    expect(src).not.toMatch(/className="grid grid-cols-2/);
    expect(src).toMatch(/grid grid-cols-1 gap-3 sm:grid-cols-2/);
  });

  it('every field is at least 44px tall for a finger: the select class and each text field carry min-h-[44px]', () => {
    expect(src).toMatch(/const selectClass = 'w-full min-h-\[44px\] /);
    const inputs = src.match(/<Input\b[\s\S]*?\/>/g) ?? [];
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    for (const tag of inputs) expect(tag).toContain('min-h-[44px]');
  });
});

// ── The event form's rules, run (event-form.ts) ────────────────────────────────────────────────────────
describe('L3 - the event form\'s rules (event-form.ts)', () => {
  interface Body { podId: string; title: string; description?: string; scheduledAt: string; format: string; config: Record<string, unknown> }
  interface Rules {
    formatFor: (picked: string | null, podType: string | undefined) => string;
    offeredFor: (podType: string | undefined) => string[];
    switchNotice: (picked: string | null, podType: string | undefined, format: string) => string | null;
    meetingLengthsFor: (format: string) => number[];
    fieldMessage: (format: string, key: string, value: unknown) => string | true;
    sessionBody: (data: Record<string, unknown>) => Body;
    serverFieldErrors: (error: unknown) => { fields: Array<{ name: string; message: string }>; format: string | null; toast: string | null };
  }
  const rules = (): Rules => loadClientModule(EVENT_FORM, {}) as unknown as Rules;
  const form = {
    podId: 'p1', title: 'Our check-in', description: '', scheduledAt: '2026-10-30T10:00', numberOfRounds: 3, roundDurationSeconds: 300,
    durationMinutes: 90, maxParticipants: 20, timerVisibility: 'always_visible', matchingTemplateId: '', matchingPolicy: 'within_event',
  };

  it('the format follows the pod until the organiser picks one its type holds', () => {
    const { formatFor, offeredFor } = rules();
    expect(offeredFor('reason')).toEqual(['video_meeting', 'speed_networking']);
    expect(offeredFor('chat')).toEqual(['video_meeting']);
    // Before a pod is chosen: the formats on offer, never voice, webinar or in person.
    expect(offeredFor(undefined)).toEqual(['speed_networking', 'video_meeting']);
    expect(formatFor(null, 'reason')).toBe('video_meeting');
    expect(formatFor('speed_networking', 'reason')).toBe('speed_networking');
    expect(formatFor('speed_networking', 'chat')).toBe('video_meeting');
    expect(formatFor('video_meeting', undefined)).toBe('video_meeting');
    expect(formatFor(null, undefined)).toBe('speed_networking');
  });

  it('says it in its own words when a pod cannot hold the format that was picked, and nothing when nothing moved', () => {
    const { switchNotice } = rules();
    expect(switchNotice('speed_networking', 'chat', 'video_meeting')).toBe("Changed to Video meeting: Speed networking isn't available in this pod.");
    expect(switchNotice('speed_networking', 'reason', 'speed_networking')).toBeNull();
    expect(switchNotice(null, 'chat', 'video_meeting')).toBeNull();
    expect(switchNotice('speed_networking', undefined, 'speed_networking')).toBeNull();
    // Not the shared refusal copy cut up with a pattern.
    const source = readClientSource(EVENT_FORM);
    expect(source).not.toMatch(/formatRefusal/);
    expect(source).not.toMatch(/ Choose /);
  });

  it('a meeting\'s lengths are the ones inside its limits, and out-of-range values are said in the definition\'s words', () => {
    const { meetingLengthsFor, fieldMessage } = rules();
    expect(meetingLengthsFor('video_meeting')).toEqual([15, 30, 45, 60, 90, 120, 180, 240]);
    expect(fieldMessage('video_meeting', 'maxParticipants', 500)).toBe('Capacity must be between 2 and 100 people.');
    expect(fieldMessage('video_meeting', 'maxParticipants', 20)).toBe(true);
    expect(fieldMessage('speed_networking', 'numberOfRounds', 25)).toBe('Number of rounds must be between 1 and 20.');
    expect(fieldMessage('speed_networking', 'numberOfRounds', NaN)).toBe('Number of rounds must be a number.');
  });

  it('what is posted for speed networking is what it always was, with the format at the top', () => {
    const body = rules().sessionBody({ ...form, format: 'speed_networking', matchingTemplateId: 't1', description: 'Notes' });
    expect(body).toEqual({
      podId: 'p1', title: 'Our check-in', description: 'Notes', scheduledAt: new Date('2026-10-30T10:00').toISOString(), format: 'speed_networking',
      config: {
        eventType: 'speed_networking', numberOfRounds: 3, roundDurationSeconds: 300, maxParticipants: 20,
        timerVisibility: 'always_visible', matchingPolicy: 'within_event', matchingTemplateId: 't1',
      },
    });
    // No template chosen: none is sent. No description: none is sent.
    const plain = rules().sessionBody({ ...form, format: 'speed_networking' });
    expect(plain.config).not.toHaveProperty('matchingTemplateId');
    expect(plain.description).toBeUndefined();
  });

  it('what is posted for a video meeting is its length and capacity and no round settings at all', () => {
    const body = rules().sessionBody({ ...form, format: 'video_meeting' });
    expect(body.format).toBe('video_meeting');
    expect(body.config).toEqual({ eventType: 'video_meeting', durationMinutes: 90, maxParticipants: 20 });
  });

  it('a refusal is said at the field it is about, in the server\'s words, and only what has no field becomes a toast', () => {
    const { serverFieldErrors } = rules();
    const refusal = (details: unknown, message = 'Capacity must be between 2 and 100 people.') => ({ response: { data: { error: { code: 'VALIDATION_ERROR', message, details } } } });
    // The definition's own checks answer by setting.
    expect(serverFieldErrors(refusal({ maxParticipants: ['Capacity must be between 2 and 100 people.'] }))).toEqual({
      fields: [{ name: 'maxParticipants', message: 'Capacity must be between 2 and 100 people.' }], format: null, toast: null,
    });
    // The round length is minutes to the server and seconds on this form.
    expect(serverFieldErrors(refusal({ roundMinutes: ['Round length must be between 1 and 60 minutes.'] })).fields).toEqual([
      { name: 'roundDurationSeconds', message: 'Round length must be between 1 and 60 minutes.' },
    ]);
    // A schema check names the path inside the config.
    expect(serverFieldErrors(refusal({ 'config.numberOfRounds': ['Number must be less than or equal to 20'] })).fields[0].name).toBe('numberOfRounds');
    // A format the pod does not hold belongs at the picker.
    expect(serverFieldErrors(refusal({ format: ["Speed networking isn't available in Chat pods."] }, "Speed networking isn't available in Chat pods."))).toEqual({
      fields: [], format: "Speed networking isn't available in Chat pods.", toast: null,
    });
    // Several at once: each at its own field.
    expect(serverFieldErrors(refusal({ maxParticipants: ['a'], durationMinutes: ['b'] })).fields.map((f) => f.name)).toEqual(['maxParticipants', 'durationMinutes']);
  });

  it('what has no field is a toast: an unknown setting, no details at all, or no answer from the server', () => {
    const { serverFieldErrors } = rules();
    const refusal = (details: unknown, message: string) => ({ response: { data: { error: { code: 'X', message, details } } } });
    expect(serverFieldErrors(refusal({ somethingElse: ['x'] }, 'That did not work.'))).toEqual({ fields: [], format: null, toast: 'That did not work.' });
    expect(serverFieldErrors(refusal(undefined, 'Only pod directors and hosts can create sessions'))).toEqual({
      fields: [], format: null, toast: 'Only pod directors and hosts can create sessions',
    });
    expect(serverFieldErrors(new Error('Network Error'))).toEqual({ fields: [], format: null, toast: 'Failed to create event' });
    // A placed one and one that could not be placed: both are said, the second in a toast.
    const mixed = serverFieldErrors(refusal({ maxParticipants: ['Capacity must be between 2 and 100 people.'], odd: ['y'] }, 'Validation failed'));
    expect(mixed.fields).toHaveLength(1);
    expect(mixed.toast).toBe('Validation failed');
  });
});

// ── The event form, drawn ──────────────────────────────────────────────────────────────────────────────
describe('L3 - CreateSessionPage follows the pod\'s type and the chosen format', () => {
  const src = readClientSource(SESSION_PAGE);

  /** `podType` null: no pod named in the address. `loading`: the lists are still arriving. */
  function drawPage(podType: string | null, opts: { loading?: boolean } = {}): string {
    const pods = podType ? [{ id: 'p1', name: 'Test', podType, memberRole: 'director' }] : [];
    const mod = loadClientModule(SESSION_PAGE, {
      'react-router-dom': { useNavigate: () => () => undefined, useSearchParams: () => [new URLSearchParams(podType ? 'podId=p1' : ''), () => undefined] },
      '@tanstack/react-query': {
        useMutation: () => ({ mutate: () => undefined, isPending: false }),
        useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
          if (queryKey[0] === 'my-pods') return opts.loading ? { data: undefined, isLoading: true } : { data: pods, isLoading: false };
          return { data: queryKey[0] === 'pod' ? undefined : [], isLoading: false };
        },
      },
      '@/components/ui/Card': { __esModule: true, default: ({ children, ...rest }: { children?: ReactNode }) => createElement('section', rest, children) },
      '@/components/ui/Input': {
        __esModule: true,
        default: forwardRef<HTMLInputElement, { label?: string }>(({ label, ...props }, ref) => createElement('div', null, label ? createElement('label', null, label) : null, createElement('input', { ref, ...props }))),
      },
      '@/components/ui/Button': { Button: ({ children }: { children?: ReactNode }) => createElement('button', null, children) },
      '@/stores/toastStore': { useToastStore: () => ({ addToast: () => undefined }) },
      '@/stores/authStore': { useAuthStore: () => ({ user: { id: 'u1', role: 'member' } }) },
      'lucide-react': iconStandIns,
      '@/lib/api': { __esModule: true, default: { get: () => undefined, post: () => undefined } },
      '@/lib/utils': { localTimezoneLabel: () => 'GMT+0 (test)' },
      '@/realtime/entities': { E: { userPods: (id: string) => `user:${id}:pods`, pod: (id: string) => `pod:${id}` } },
    });
    return renderToStaticMarkup(createElement(mod.default as ComponentType));
  }

  it('a Reason pod\'s event is a video meeting: no Number of Rounds, no round settings, a Length, and the pod\'s own two formats to pick from', () => {
    const html = drawPage('reason');
    const text = words(html);
    expect(text).not.toContain('Number of Rounds');
    expect(text).not.toContain('Round Duration');
    expect(text).not.toContain('Timer Visibility');
    expect(text).not.toContain('Matching Policy');
    expect(html).not.toContain('Timing Configuration');
    expect(html).toContain('data-testid="meeting-length"');
    expect(optionsOf(html, '<select data-testid="event-format-select"')).toEqual(['Video meeting', 'Speed networking']);
    // The words under the picker are the chosen format's, not speed networking's.
    expect(text).toContain('Everyone together in one video room until the host ends it');
    expect(text).not.toContain('Timed one-to-one rounds with automatic matching');
  });

  it('a Speed Networking pod\'s event is speed networking: the rounds card is there, with its rounds, length, timer and matching rule', () => {
    const html = drawPage('speed_networking');
    const text = words(html);
    expect(text).toContain('Number of Rounds');
    expect(text).toContain('Round Duration');
    expect(text).toContain('Timer Visibility');
    expect(text).toContain('Matching Policy');
    expect(html).not.toContain('data-testid="meeting-length"');
    expect(optionsOf(html, '<select data-testid="event-format-select"')).toEqual(['Speed networking', 'Video meeting']);
    expect(text).toContain('Timed one-to-one rounds with automatic matching');
  });

  it('a Chat pod holds video meetings only, so there is nothing to pick: the format is said, not offered', () => {
    const html = drawPage('chat');
    expect(html).not.toContain('data-testid="event-format-select"');
    expect(html).toContain('data-testid="event-format-fixed"');
    expect(words(html)).not.toContain('Number of Rounds');
  });

  it('before a pod is chosen it offers the formats on offer today (speed networking, video meeting), never voice, webinar or in person', () => {
    const html = drawPage(null);
    expect(optionsOf(html, '<select data-testid="event-format-select"')).toEqual(['Speed networking', 'Video meeting']);
  });

  it('while a pod named in the address is still being found, a placeholder is held: speed networking\'s settings are not drawn and swapped away', () => {
    const html = drawPage('reason', { loading: true });
    expect(html).toContain('data-testid="format-pending"');
    expect(html).toContain('data-testid="settings-pending"');
    expect(html).toContain('aria-busy="true"');
    // Nothing of any format is drawn yet: not the rounds, not the meeting's length, not a capacity for either.
    for (const testId of ['event-format-select', 'event-format-fixed', 'timing-card', 'meeting-card', 'capacity-card', 'meeting-length']) {
      expect(html).not.toContain(`data-testid="${testId}"`);
    }
    expect(words(html)).not.toContain('Number of Rounds');
    expect(words(html)).not.toContain('Max Participants');
    // What a person who cannot see it is told.
    expect(words(html)).toContain("Loading this pod's event types");
  });

  it('with no pod named, there is nothing to wait for: the generic form is drawn at once, even while the list arrives', () => {
    const html = drawPage(null, { loading: true });
    expect(html).not.toContain('data-testid="format-pending"');
    expect(html).toContain('data-testid="event-format-select"');
    expect(html).toContain('data-testid="timing-card"');
  });

  it('capacity follows the format\'s own limits: 2 to 100 for a meeting, 2 to 10,000 for speed networking', () => {
    expect(words(drawPage('reason'))).toContain('2 – 100 participants');
    expect(words(drawPage('speed_networking'))).toContain('2 – 10,000 participants');
  });

  it('the Scheduled At field still names the local time zone, whichever format is chosen', () => {
    for (const pod of ['reason', 'speed_networking', null]) {
      expect(words(drawPage(pod)).join(' ')).toContain('Shown in your local time — GMT+0 (test).');
    }
  });

  it('a pod named in the address is the one chosen in the Pod select as it is drawn, with no effect to put it there', () => {
    expect(drawPage('reason')).toMatch(/<option value="p1" selected="">Test<\/option>/);
  });

  it('keeps the list of pods one array until the list or the role changes, and nothing re-sets the pod by effect', () => {
    // A member's list is filtered. Filtered afresh on every render it was a new value each time, and an effect that
    // depended on it and set the (watched) pod ran after every render, for good: 2,400 React commits in 2 seconds, on the
    // form a plain pod director reaches from the pod page. The e2e counts commits; these keep the cause out.
    expect(src).toMatch(/useMemo<PodRow\[\]>\(/);
    expect(src).toMatch(/\[allPods, isAdmin\]/);
    expect(src).not.toMatch(/setValue\('podId'/);
    expect(src).toMatch(/value=\{podId\}/);
    // The fallback read of a pod the list lacks gives up at once: a pod that cannot be read must not hold a placeholder.
    expect(src).toMatch(/enabled: !!podId && !!allPods && !listedPod,\s*retry: false,/);
  });

  it('the page posts what sessionBody builds, and says a refusal at its field with setError, not in a bare toast', () => {
    expect(src).toMatch(/mutationFn:[^\n]*sessionBody\(data\)/);
    expect(src).toMatch(/serverFieldErrors\(err\)/);
    expect(src).toMatch(/setError\(f\.name, \{ type: 'server', message: f\.message \}, \{ shouldFocus: i === 0 \}\)/);
    expect(src).not.toMatch(/error\?\.message \|\| 'Failed to create event'/);
  });

  it('a note about a capacity that was changed is at Capacity, and a note about a format that was changed is at Event Type', () => {
    const cardAt = src.indexOf('data-testid="capacity-card"');
    const capacityNoteAt = src.indexOf('data-testid="capacity-notice"');
    const formatNoteAt = src.indexOf('data-testid="event-format-notice"');
    expect(cardAt).toBeGreaterThan(0);
    expect(capacityNoteAt).toBeGreaterThan(cardAt);
    expect(formatNoteAt).toBeGreaterThan(0);
    expect(formatNoteAt).toBeLessThan(cardAt);
    // The capacity note is done with once the organiser edits capacity.
    expect(src).toMatch(/onChange: \(\) => ev\.touch\('maxParticipants'\)/);
    expect(readClientSource(EVENT_HOOK)).toMatch(/if \(field === 'maxParticipants'\) setCapacityNotices\(\[\]\);/);
  });

  it('the page stays a page: the form\'s rules are in event-form.ts and its state in useEventFormat.ts', () => {
    for (const name of ['formatFor', 'rangeHint', 'roundSeconds', 'fieldMessage', 'switchNotice', 'sessionBody', 'serverFieldErrors']) {
      expect(src).not.toMatch(new RegExp(`function ${name}\\b`));
    }
    expect(src).not.toMatch(/useRef|useEffect/);
    expect(src).toMatch(/useEventFormat\(/);
    expect(src.split('\n').length).toBeLessThan(380);
  });

  it('every field is at least 44px tall for a finger: the select class and each text field carry min-h-[44px]', () => {
    // The class the page and the rounds card both use is one constant, in form-parts.tsx.
    expect(readClientSource('features/sessions/form-parts.tsx')).toMatch(/export const selectClass = 'w-full min-h-\[44px\] /);
    expect(src).toMatch(/import \{ FieldError, selectClass \} from '\.\/form-parts';/);
    expect(readClientSource('features/sessions/RoundsSettings.tsx')).toMatch(/import \{ FieldError, selectClass \} from '\.\/form-parts';/);
    const inputs = src.match(/<Input\b[\s\S]*?\/>/g) ?? [];
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    for (const tag of inputs) expect(tag).toContain('min-h-[44px]');
  });

  it('reads the shared definition, with no list of event types of its own', () => {
    const all = [src, readClientSource(EVENT_FORM), readClientSource(EVENT_HOOK)].join('\n');
    expect(all).toMatch(/from '@rsn\/shared'/);
    for (const name of ['eventFormatsForPod', 'defaultEventFormat', 'defaultTitle', 'liveKindOf', 'applyFormatChange']) {
      expect(all).toContain(name);
    }
    expect(src).not.toMatch(/const EVENT_TYPES/);
    expect(all).not.toMatch(/eventType:\s*['"]speed_networking['"]/);
  });

  it('the title starts as the format and the pod ("Video meeting · Test") until the organiser writes their own, and is not guessed while the pod is unknown', () => {
    const hook = readClientSource(EVENT_HOOK);
    expect(src).toMatch(/podName: pod\?\.name \?\? ''/);
    expect(hook).toMatch(/defaultTitle\(format, podName\)/);
    // Typing a title of their own is what stops it following.
    expect(src).toMatch(/register\('title', \{[^}]*onChange: \(\) => ev\.touch\('title'\)/);
    expect(hook).toMatch(/if \(!touched\.current\.has\('title'\)\) setValue\('title'/);
    // Nothing follows a format that is not known yet.
    expect(hook.match(/if \(pending\) return;/g)).toHaveLength(2);
    expect(src).toMatch(/title: '',/);
  });
});
