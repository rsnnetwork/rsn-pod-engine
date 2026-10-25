// ─── The pure rules over the event definition (26 Oct 2026) ──────────────────────────────────────
//
// shared/src/events/rules.ts: the helpers every create and edit screen and the server use, so a pod type,
// its orchestration, the formats it may hold, a format's fields and defaults, a meeting's length and how an
// event's format is read from old rows are decided in one place.

import {
  resolveEventFormat, liveKindOf, formatRule, podTypeRule, isEventFormat, effectiveOrchestration,
  eventFormatsForPod, defaultEventFormat, fieldsFor, defaultsFor, defaultTitle, checkEventInput,
  normaliseConfig, valuesFromConfig, eventDurationMinutes, applyTypeChange, applyFormatChange, formatRefusal,
  PodType, OrchestrationMode, CommunicationMode, DEFAULT_SESSION_CONFIG,
} from '@rsn/shared';
import { computeSessionDurationMinutes } from '../../services/calendar/calendar.service';

describe('resolveEventFormat: the column, then an offered legacy config.eventType, else speed networking', () => {
  it('reads nothing as speed networking', () => {
    expect(resolveEventFormat({})).toBe('speed_networking');
    expect(resolveEventFormat({ config: null })).toBe('speed_networking');
    expect(resolveEventFormat(null)).toBe('speed_networking');
  });

  it("honours the old form's video meeting when there is no column (option O1)", () => {
    expect(resolveEventFormat({ config: { eventType: 'video_meeting' } })).toBe('video_meeting');
  });

  it('reads a legacy format that is not offered yet as speed networking', () => {
    expect(resolveEventFormat({ config: { eventType: 'webinar' } })).toBe('speed_networking');
  });

  it('lets the column win over the legacy config value', () => {
    expect(resolveEventFormat({ format: 'video_meeting', config: { eventType: 'speed_networking' } })).toBe('video_meeting');
    expect(resolveEventFormat({ format: 'speed_networking', config: { eventType: 'video_meeting' } })).toBe('speed_networking');
  });

  it('reads nonsense as speed networking, wherever it is', () => {
    expect(resolveEventFormat({ format: 'nonsense' })).toBe('speed_networking');
    expect(resolveEventFormat({ config: { eventType: 'nonsense' } })).toBe('speed_networking');
    expect(resolveEventFormat({ format: 42, config: { eventType: ['video_meeting'] } })).toBe('speed_networking');
  });
});

describe('liveKindOf, formatRule and podTypeRule', () => {
  it('tells rounds from a meeting', () => {
    expect(liveKindOf('speed_networking')).toBe('rounds');
    expect(liveKindOf('video_meeting')).toBe('meeting');
    expect(liveKindOf('physical_event')).toBe('none');
  });

  it('falls back to speed networking for a value that is not a format (old Redis data)', () => {
    expect(formatRule('nonsense' as never).label).toBe('Speed networking');
    expect(liveKindOf('nonsense' as never)).toBe('rounds');
    expect(isEventFormat('video_meeting')).toBe(true);
    expect(isEventFormat('duo')).toBe(false);
  });

  it('reads an unknown pod type as a speed-networking pod', () => {
    expect(podTypeRule('duo' as never).label).toBe('Speed Networking');
  });
});

describe('orchestration follows the pod type', () => {
  it('keeps a stored mode the type allows', () => {
    expect(effectiveOrchestration({ podType: PodType.REASON, orchestrationMode: OrchestrationMode.MODERATED }))
      .toBe(OrchestrationMode.MODERATED);
  });

  it("reads an old Reason pod saved as timed rounds as Freeform, without writing anything", () => {
    expect(effectiveOrchestration({ podType: PodType.REASON, orchestrationMode: OrchestrationMode.TIMED_ROUNDS }))
      .toBe(OrchestrationMode.FREE_FORM);
    expect(effectiveOrchestration({ podType: PodType.SPEED_NETWORKING, orchestrationMode: OrchestrationMode.FREE_FORM }))
      .toBe(OrchestrationMode.TIMED_ROUNDS);
  });

  it('gives a pod with no mode its type default', () => {
    expect(effectiveOrchestration({ podType: PodType.REASON, orchestrationMode: null })).toBe(OrchestrationMode.FREE_FORM);
  });
});

describe('formats a pod may hold', () => {
  it('a Reason pod holds video meetings (first) and speed networking', () => {
    expect(eventFormatsForPod(PodType.REASON)).toEqual(['video_meeting', 'speed_networking']);
    expect(defaultEventFormat(PodType.REASON)).toBe('video_meeting');
  });

  it('a speed-networking pod defaults to speed networking', () => {
    expect(eventFormatsForPod(PodType.SPEED_NETWORKING)).toEqual(['speed_networking', 'video_meeting']);
    expect(defaultEventFormat(PodType.SPEED_NETWORKING)).toBe('speed_networking');
  });

  it('never offers a format that is not available yet', () => {
    expect(eventFormatsForPod(PodType.WEBINAR)).toEqual(['video_meeting']);
    expect(eventFormatsForPod(PodType.PHYSICAL_EVENT)).toEqual(['video_meeting']);
  });
});

describe('formatRefusal: why a pod cannot hold a format, in a sentence', () => {
  it('says nothing when the pod holds the format', () => {
    expect(formatRefusal(PodType.REASON, 'video_meeting')).toBeNull();
    expect(formatRefusal(PodType.REASON, 'speed_networking')).toBeNull();
  });

  it('names what to choose instead', () => {
    expect(formatRefusal(PodType.CHAT, 'speed_networking')).toBe("Speed networking isn't available in Chat pods. Choose Video meeting.");
    expect(formatRefusal(PodType.WEBINAR, 'speed_networking')).toBe("Speed networking isn't available in Webinar pods. Choose Video meeting.");
  });

  it('says a format is not offered yet, wherever it is asked for', () => {
    expect(formatRefusal(PodType.WEBINAR, 'webinar')).toBe("Webinar isn't offered yet.");
    expect(formatRefusal(PodType.REASON, 'physical_event')).toBe("In person isn't offered yet.");
  });
});

describe('fields, defaults and the title', () => {
  it('lists each format’s fields and their defaults', () => {
    expect(fieldsFor('video_meeting')).toEqual(['durationMinutes', 'maxParticipants']);
    expect(defaultsFor('video_meeting')).toEqual({ durationMinutes: 60, maxParticipants: 25 });
    expect(fieldsFor('speed_networking')).toEqual(
      ['numberOfRounds', 'roundMinutes', 'timerVisibility', 'matchingPolicy', 'matchingTemplateId', 'maxParticipants'],
    );
    // The admin-only template has no default: "Default" is simply leaving it empty.
    expect(defaultsFor('speed_networking')).toEqual({
      numberOfRounds: 5, roundMinutes: 8, timerVisibility: 'last_10s', matchingPolicy: 'within_event', maxParticipants: 500,
    });
  });

  it('prefills the title from the format and the pod', () => {
    expect(defaultTitle('video_meeting', 'Test')).toBe('Video meeting · Test');
    expect(defaultTitle('speed_networking', '  Founders Club ')).toBe('Speed networking · Founders Club');
    expect(defaultTitle('video_meeting', '   ')).toBe('Video meeting');
  });
});

describe('checkEventInput', () => {
  it('accepts values inside the limits, and ignores fields the format does not have', () => {
    expect(checkEventInput('video_meeting', { durationMinutes: 90, maxParticipants: 12, numberOfRounds: 99 })).toEqual([]);
    expect(checkEventInput('speed_networking', { numberOfRounds: 3, roundMinutes: 2.5, timerVisibility: 'hidden' })).toEqual([]);
  });

  it('says what is wrong, at the field, in a sentence', () => {
    expect(checkEventInput('video_meeting', { durationMinutes: 10, maxParticipants: 500 })).toEqual([
      { field: 'durationMinutes', message: 'Length must be between 15 and 240 minutes.' },
      { field: 'maxParticipants', message: 'Capacity must be between 2 and 100 people.' },
    ]);
    expect(checkEventInput('speed_networking', { numberOfRounds: 0 })).toEqual([
      { field: 'numberOfRounds', message: 'Number of rounds must be between 1 and 20.' },
    ]);
  });

  it('refuses a value that is not a number, and a choice that is not on the list', () => {
    expect(checkEventInput('video_meeting', { durationMinutes: 'an hour' })).toEqual([
      { field: 'durationMinutes', message: 'Length must be a number.' },
    ]);
    expect(checkEventInput('speed_networking', { timerVisibility: 'sometimes' })).toEqual([
      { field: 'timerVisibility', message: 'Choose one of the timer options.' },
    ]);
  });

  it('leaves an empty field to its default', () => {
    expect(checkEventInput('video_meeting', { durationMinutes: undefined, maxParticipants: '' })).toEqual([]);
  });
});

describe('normaliseConfig: the stored config for an event of this format', () => {
  it('turns the old form’s video meeting into a meeting config: no round settings left', () => {
    const fromOldForm = {
      eventType: 'video_meeting', numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500,
      timerVisibility: 'always_visible', matchingPolicy: 'within_event',
    };
    expect(normaliseConfig('video_meeting', fromOldForm)).toEqual({
      durationMinutes: 60, maxParticipants: 500, eventType: 'video_meeting',
    });
  });

  it('gives a speed-networking event exactly the engine defaults it always had, and says its format', () => {
    expect(normaliseConfig('speed_networking', {})).toEqual({ ...DEFAULT_SESSION_CONFIG, eventType: 'speed_networking' });
    const custom = { numberOfRounds: 3, roundDurationSeconds: 120, ratingWindowSeconds: 20, matchingTemplateId: 't1' };
    expect(normaliseConfig('speed_networking', custom)).toEqual({
      ...DEFAULT_SESSION_CONFIG, ...custom, eventType: 'speed_networking',
    });
  });

  it('stores a round length given in minutes as whole seconds, and never the minutes field itself', () => {
    const out = normaliseConfig('speed_networking', { roundMinutes: 2.5 });
    expect(out.roundDurationSeconds).toBe(150);
    expect(out).not.toHaveProperty('roundMinutes');
  });

  it('reads a meeting length the client sent', () => {
    expect(normaliseConfig('video_meeting', { durationMinutes: 90, maxParticipants: 8 }))
      .toEqual({ durationMinutes: 90, maxParticipants: 8, eventType: 'video_meeting' });
  });
});

describe('valuesFromConfig: what an edit form shows', () => {
  it('shows a stored round length in minutes', () => {
    expect(valuesFromConfig('speed_networking', { numberOfRounds: 3, roundDurationSeconds: 150, maxParticipants: 40 }))
      .toEqual({ numberOfRounds: 3, roundMinutes: 2.5, timerVisibility: 'last_10s', matchingPolicy: 'within_event', maxParticipants: 40 });
  });

  it('shows a meeting’s length and capacity, defaulting what is missing', () => {
    expect(valuesFromConfig('video_meeting', { durationMinutes: 45 })).toEqual({ durationMinutes: 45, maxParticipants: 25 });
  });
});

describe('eventDurationMinutes: one formula for every length (token, calendar, invite)', () => {
  it.each([
    {},
    { numberOfRounds: 3, roundDurationSeconds: 60, ratingWindowSeconds: 30, transitionDurationSeconds: 30, closingLobbyDurationSeconds: 120 },
    { ...DEFAULT_SESSION_CONFIG },
    { numberOfRounds: 1, roundDurationSeconds: 3600 },
  ])('equals computeSessionDurationMinutes for speed networking (%j)', (cfg) => {
    expect(eventDurationMinutes('speed_networking', cfg)).toBe(computeSessionDurationMinutes(cfg));
  });

  it('is the length for a meeting, its default when unset', () => {
    expect(eventDurationMinutes('video_meeting', { durationMinutes: 90 })).toBe(90);
    expect(eventDurationMinutes('video_meeting', {})).toBe(60);
    expect(eventDurationMinutes('video_meeting', null)).toBe(60);
  });
});

describe('applyTypeChange: a type change never silently overwrites a choice', () => {
  it('keeps a value the member chose when the new type still allows it', () => {
    const out = applyTypeChange(
      { podType: PodType.CONVERSATIONAL, orchestrationMode: OrchestrationMode.MODERATED, name: 'Book club' },
      PodType.REASON,
      new Set(['orchestrationMode']),
    );
    expect(out.values).toMatchObject({ podType: PodType.REASON, orchestrationMode: OrchestrationMode.MODERATED, name: 'Book club' });
    expect(out.notices).toEqual([]);
  });

  it('replaces a chosen value the new type does not allow, and says so', () => {
    const out = applyTypeChange(
      { podType: PodType.SPEED_NETWORKING, orchestrationMode: OrchestrationMode.TIMED_ROUNDS },
      PodType.REASON,
      new Set(['orchestrationMode']),
    );
    expect(out.values.orchestrationMode).toBe(OrchestrationMode.FREE_FORM);
    expect(out.notices).toEqual(["Changed to Freeform: Reason pods don't use timed rounds."]);
  });

  it('moves an untouched value to the new type’s default without a notice (what Claus asked for)', () => {
    const out = applyTypeChange(
      { podType: PodType.SPEED_NETWORKING, orchestrationMode: OrchestrationMode.TIMED_ROUNDS, communicationMode: CommunicationMode.VIDEO },
      PodType.CHAT,
      new Set(),
    );
    expect(out.values).toMatchObject({ orchestrationMode: OrchestrationMode.FREE_FORM, communicationMode: CommunicationMode.TEXT });
    expect(out.notices).toEqual([]);
  });

  it('keeps a communication mode the member chose', () => {
    const out = applyTypeChange(
      { podType: PodType.SPEED_NETWORKING, communicationMode: CommunicationMode.AUDIO },
      PodType.CHAT,
      new Set(['communicationMode']),
    );
    expect(out.values.communicationMode).toBe(CommunicationMode.AUDIO);
  });
});

describe('applyFormatChange: switching format asks before it discards what the organiser set', () => {
  it('switches untouched settings to the new format’s defaults without asking', () => {
    const out = applyFormatChange(
      { format: 'speed_networking', numberOfRounds: 5, roundMinutes: 8, maxParticipants: 500 },
      'video_meeting',
      new Set(),
    );
    expect(out.needsConfirm).toBe(false);
    expect(out.notices).toEqual([]);
    expect(out.values).toMatchObject({ format: 'video_meeting', durationMinutes: 60, maxParticipants: 25 });
  });

  it('asks before removing round settings the organiser set', () => {
    const out = applyFormatChange(
      { format: 'speed_networking', numberOfRounds: 5, roundMinutes: 8, maxParticipants: 500 },
      'video_meeting',
      new Set(['numberOfRounds', 'roundMinutes']),
    );
    expect(out.needsConfirm).toBe(true);
    expect(out.notices).toEqual(['Switching to Video meeting removes the round settings (5 rounds × 8 min). Continue?']);
  });

  it('keeps hidden settings in the form, so switching back restores them', () => {
    const out = applyFormatChange(
      { format: 'speed_networking', numberOfRounds: 4, roundMinutes: 6 },
      'video_meeting',
      new Set(['numberOfRounds']),
    );
    expect(out.values).toMatchObject({ numberOfRounds: 4, roundMinutes: 6 });
  });

  it('keeps a chosen capacity the new format allows, and replaces one it does not, with a notice', () => {
    const kept = applyFormatChange({ format: 'speed_networking', maxParticipants: 40 }, 'video_meeting', new Set(['maxParticipants']));
    expect(kept.values.maxParticipants).toBe(40);
    expect(kept.notices).toEqual([]);

    const replaced = applyFormatChange({ format: 'speed_networking', maxParticipants: 300 }, 'video_meeting', new Set(['maxParticipants']));
    expect(replaced.values.maxParticipants).toBe(25);
    expect(replaced.notices).toEqual(['Capacity changed to 25 people: a video meeting allows 2 to 100.']);
    expect(replaced.needsConfirm).toBe(false);
  });

  it('asks before removing a meeting length the organiser set', () => {
    const out = applyFormatChange({ format: 'video_meeting', durationMinutes: 90 }, 'speed_networking', new Set(['durationMinutes']));
    expect(out.needsConfirm).toBe(true);
    expect(out.notices).toEqual(['Switching to Speed networking removes the video meeting settings (90 min). Continue?']);
    expect(out.values).toMatchObject({ format: 'speed_networking', numberOfRounds: 5, roundMinutes: 8, durationMinutes: 90 });
  });
});
