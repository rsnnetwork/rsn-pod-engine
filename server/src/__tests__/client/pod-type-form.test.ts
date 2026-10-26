// server/src/__tests__/client/pod-type-form.test.ts
// The pod forms' rules (C7, 26 Oct 2026), EXECUTED: what a new, duplicated or edited pod starts on, what a change
// of pod type does to its orchestration (a setting follows the type until the member sets it, and is never
// replaced silently), the hidden communication setting, the size hint, what the forms send and how a refusal
// lands. pod-type-form.ts is pure (no React, axios, store or router), so it runs here.
//
// 25 Oct walkthrough (production): "Pod type: Reason pod. Orchestration is of course not timed rounds, it's
// freeform, but that should be automatic when I choose Reason pod" (Claus, 2:46:24). They set Free Form by hand.
import {
  POD_NAME_REQUIRED, TYPE_CHANGE_NOTE, changeType, editPodValues, maxMembersProblem, newPodValues, orchestrationChoice,
  podBody, podChanges, podNameProblem, podProblems, podTypeChoices, sizeHint,
} from '../../../../client/src/features/pods/pod-type-form';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';

const refused = (status: number, error: Record<string, unknown>) => ({ isAxiosError: true, response: { status, data: { success: false, error } } });
const COPY = { fallback: 'Could not create the pod just now. Try again in a moment.', forbidden: 'Only the pod director can change this pod.' };

describe('a new pod', () => {
  it("starts on a type's own orchestration and communication, read from the shared table", () => {
    const { values, chosen, notices } = newPodValues();
    expect(values.podType).toBe('speed_networking');
    expect(values.orchestrationMode).toBe('timed_rounds');
    expect(values.communicationMode).toBe('video');
    expect(chosen.size).toBe(0);
    expect(notices).toEqual([]);
    expect([values.name, values.description, values.visibility, values.maxMembers, values.allowMemberInvites]).toEqual(['', '', 'private', '', false]);
  });

  it('choosing Reason makes it Freeform without the member touching orchestration, and says nothing', () => {
    const { values } = newPodValues();
    const r = changeType(values, 'reason' as never, new Set());
    expect(r.values.podType).toBe('reason');
    expect(r.values.orchestrationMode).toBe('free_form');
    expect(r.values.communicationMode).toBe('video');
    expect(r.notices).toEqual([]);
  });

  it('a mode the member chose that the new type does not use is replaced, and they are told', () => {
    const { values } = newPodValues();
    const r = changeType({ ...values, orchestrationMode: 'timed_rounds' as never }, 'reason' as never, new Set(['orchestrationMode']));
    expect(r.values.orchestrationMode).toBe('free_form');
    expect(r.notices).toEqual(["Changed to Freeform: Reason pods don't use timed rounds."]);
  });

  it('a mode the member chose that the new type also allows stays', () => {
    const reason = changeType(newPodValues().values, 'reason' as never, new Set()).values;
    const r = changeType({ ...reason, orchestrationMode: 'moderated' as never }, 'conversational' as never, new Set(['orchestrationMode']));
    expect(r.values.orchestrationMode).toBe('moderated');
    expect(r.notices).toEqual([]);
  });

  it('communication is never asked: it follows the type (a Chat pod is text, a Physical Event hybrid)', () => {
    const { values } = newPodValues();
    expect(changeType(values, 'chat' as never, new Set()).values.communicationMode).toBe('text');
    expect(changeType(values, 'physical_event' as never, new Set()).values.communicationMode).toBe('hybrid');
  });
});

describe('a duplicated pod', () => {
  it("carries the source pod's choices, an old Reason pod on timed rounds read as Freeform with the notice", () => {
    const { values, notices, chosen } = newPodValues({
      name: 'Test (copy)', description: 'd', podType: 'reason', orchestrationMode: 'timed_rounds', communicationMode: 'audio', visibility: 'invite_only', maxMembers: 12,
    });
    expect(values.name).toBe('Test (copy)');
    expect(values.podType).toBe('reason');
    expect(values.orchestrationMode).toBe('free_form');
    expect(values.communicationMode).toBe('video');
    expect(values.maxMembers).toBe('12');
    expect(values.visibility).toBe('invite_only');
    expect(notices).toEqual(["Changed to Freeform: Reason pods don't use timed rounds."]);
    expect(chosen.has('orchestrationMode')).toBe(true);
  });
});

describe('editing a pod', () => {
  it('its saved orchestration counts as chosen; an old combination is shown normalised, with a note, and saved only on Save', () => {
    const { values, chosen, note } = editPodValues({
      name: 'Test', description: null, podType: 'reason', orchestrationMode: 'timed_rounds', communicationMode: 'video',
      visibility: 'private', maxMembers: null, rules: null, allowMemberInvites: false,
    });
    expect(values.orchestrationMode).toBe('free_form');
    expect(chosen.has('orchestrationMode')).toBe(true);
    expect(chosen.has('communicationMode')).toBe(false);
    expect(note).toBe("This pod was set to Timed rounds, which Reason pods don't use. Saving changes it to Freeform.");
    expect([values.description, values.maxMembers, values.rules]).toEqual(['', '', '']);
  });

  it('a pod already on an allowed mode opens as it is, with no note', () => {
    const { values, note } = editPodValues({
      name: 'Deep', description: 'x', podType: 'reason', orchestrationMode: 'moderated', communicationMode: 'video',
      visibility: 'public', maxMembers: 10, rules: 'Be kind', allowMemberInvites: true,
    });
    expect(values.orchestrationMode).toBe('moderated');
    expect(values.maxMembers).toBe('10');
    expect(note).toBeNull();
  });

  it('a change of type tells the director that scheduled events keep their type', () => {
    expect(TYPE_CHANGE_NOTE).toBe('Events already scheduled keep their event type.');
  });
});

describe('the orchestration control', () => {
  it('a type with one mode shows one line, not a choice', () => {
    expect(orchestrationChoice('webinar' as never)).toEqual({
      kind: 'line', text: 'Events in this pod run as Moderated: the host leads and gives people the floor.',
    });
    expect(orchestrationChoice('chat' as never)).toEqual({
      kind: 'line', text: 'Events in this pod run as Freeform: everyone together in one room.',
    });
  });

  it('a type with several modes offers only those, the type default first', () => {
    expect(orchestrationChoice('reason' as never)).toEqual({
      kind: 'select',
      options: [
        { value: 'free_form', label: 'Freeform', summary: 'Everyone together in one room' },
        { value: 'moderated', label: 'Moderated', summary: 'The host leads and gives people the floor' },
      ],
    });
  });
});

describe('the pod type picker and the size hint', () => {
  it("lists every type with its one line from the table, Reason first", () => {
    const choices = podTypeChoices();
    expect(choices[0]).toEqual({ value: 'reason', label: 'Reason Pod', summary: 'A small group (5 to 12) that meets for depth around a shared purpose' });
    expect(choices.map((c) => c.value)).toEqual([
      'reason', 'speed_networking', 'conversational', 'webinar', 'physical_event', 'chat', 'two_sided_networking', 'one_sided_networking',
    ]);
  });

  it('a Reason pod suggests "Up to 12 recommended"; a type with no size says nothing', () => {
    expect(sizeHint('reason' as never)).toBe('Up to 12 recommended');
    expect(sizeHint('speed_networking' as never)).toBeNull();
  });
});

describe('what the pod fields accept', () => {
  it('a name is required', () => {
    expect(POD_NAME_REQUIRED).toBe('Give your pod a name');
    expect(podNameProblem('  ')).toBe('Give your pod a name');
    expect(podNameProblem('Founders')).toBeNull();
    expect(podNameProblem('x'.repeat(201))).toBe('Keep the name to 200 characters.');
  });

  it('max members is blank (no limit) or a whole number from 1 to 10,000', () => {
    expect(maxMembersProblem('')).toBeNull();
    expect(maxMembersProblem('12')).toBeNull();
    for (const bad of ['0', '-3', '2.5', '10001', 'abc']) expect(maxMembersProblem(bad)).toBe('Max members must be a whole number from 1 to 10,000.');
  });
});

describe('what the pod forms send', () => {
  it('create: the type, the orchestration shown and the communication its type implies; blank max members means none', () => {
    const reason = changeType(newPodValues().values, 'reason' as never, new Set()).values;
    expect(podBody({ ...reason, name: ' Test ', description: '' })).toEqual({
      name: 'Test', description: undefined, podType: 'reason', orchestrationMode: 'free_form', communicationMode: 'video',
      visibility: 'private', maxMembers: undefined, allowMemberInvites: false,
    });
  });

  it('create: a Public (open join) pod always lets members invite', () => {
    const { values } = newPodValues();
    expect(podBody({ ...values, name: 'Open', visibility: 'public', maxMembers: '40' })).toMatchObject({ allowMemberInvites: true, maxMembers: 40 });
  });

  it('edit: every field, a cleared max members as null (no limit), rules kept', () => {
    const { values } = editPodValues({
      name: 'Deep', description: 'x', podType: 'reason', orchestrationMode: 'moderated', communicationMode: 'video',
      visibility: 'invite_only', maxMembers: 10, rules: 'Be kind', allowMemberInvites: false,
    });
    expect(podChanges({ ...values, maxMembers: '' })).toEqual({
      name: 'Deep', description: 'x', podType: 'reason', orchestrationMode: 'moderated', communicationMode: 'video',
      visibility: 'invite_only', maxMembers: null, rules: 'Be kind', allowMemberInvites: false,
    });
  });
});

describe('a refused pod form', () => {
  it('validation details land at their fields in our words', () => {
    const err = refused(400, {
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      details: { name: ['String must contain at most 200 character(s)'], maxMembers: ['Expected integer, received float'] },
    });
    expect(podProblems(err, COPY)).toEqual({
      fields: { name: 'Keep the name to 200 characters.', maxMembers: 'Max members must be a whole number from 1 to 10,000.' },
      form: null,
    });
  });

  it('anything else is one sentence beside the button', () => {
    expect(podProblems(refused(403, { code: 'AUTH_FORBIDDEN', message: 'Insufficient permissions' }), COPY).form).toBe(COPY.forbidden);
    expect(podProblems(refused(500, { code: 'INTERNAL_ERROR', message: 'x' }), COPY).form).toBe(COPY.fallback);
    expect(podProblems(Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' }), COPY).form).toBe(CONNECTION_LOST);
  });
});
