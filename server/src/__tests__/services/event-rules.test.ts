// ─── The pure rules over the event definition (26 Oct 2026) ──────────────────────────────────────
//
// shared/src/events/rules.ts: the helpers every create and edit screen and the server use, so a pod type,
// its orchestration, the formats it may hold, a format's fields and defaults, a meeting's length and how an
// event's format is read from old rows are decided in one place.

import {
  resolveEventFormat, liveKindOf, formatRule, podTypeRule, isEventFormat, effectiveOrchestration,
  eventFormatsForPod, defaultEventFormat, fieldsFor, defaultsFor, defaultTitle, checkEventInput,
  normaliseConfig, valuesFromConfig, eventDurationMinutes, applyTypeChange, applyFormatChange, formatRefusal,
  formatOffered, missingRequired, IN_PERSON_ENABLED_CLIENTS,
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

  it('reads a row from before 26 Oct tagged physical_event, with no place, as the speed networking it ran as', () => {
    // Its column says speed networking (migration 111's default): read by the column, it stays speed networking.
    expect(resolveEventFormat({ format: 'speed_networking', config: { eventType: 'physical_event', numberOfRounds: 5 } }))
      .toBe('speed_networking');
    // Its config alone, as production's duplicate button posts it: no place, so not an in-person event.
    expect(resolveEventFormat({ config: { eventType: 'physical_event', numberOfRounds: 5 } })).toBe('speed_networking');
    expect(resolveEventFormat({ config: { eventType: 'physical_event', location: '   ' } })).toBe('speed_networking');
  });

  it('reads an in-person config with its place as in person (production duplicating a preview event)', () => {
    expect(resolveEventFormat({ config: { eventType: 'physical_event', location: 'The Ivy, London', durationMinutes: 90 } }))
      .toBe('physical_event');
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

  it('In person is offered only to a caller that asks for it, in every pod type but Webinar and Chat', () => {
    expect(formatOffered('physical_event')).toBe(false);
    expect(formatOffered('physical_event', IN_PERSON_ENABLED_CLIENTS)).toBe(true);
    expect(formatOffered('webinar', IN_PERSON_ENABLED_CLIENTS)).toBe(false);
    expect(eventFormatsForPod(PodType.REASON, IN_PERSON_ENABLED_CLIENTS)).toEqual(['video_meeting', 'speed_networking', 'physical_event']);
    expect(eventFormatsForPod(PodType.TWO_SIDED_NETWORKING, IN_PERSON_ENABLED_CLIENTS))
      .toEqual(['speed_networking', 'video_meeting', 'physical_event']);
    expect(eventFormatsForPod(PodType.WEBINAR, IN_PERSON_ENABLED_CLIENTS)).toEqual(['video_meeting']);
    expect(eventFormatsForPod(PodType.CHAT, IN_PERSON_ENABLED_CLIENTS)).toEqual(['video_meeting']);
  });

  it('a Physical Event pod starts its events in person where that is offered, and on a video meeting where it is not', () => {
    expect(defaultEventFormat(PodType.PHYSICAL_EVENT, IN_PERSON_ENABLED_CLIENTS)).toBe('physical_event');
    expect(eventFormatsForPod(PodType.PHYSICAL_EVENT, IN_PERSON_ENABLED_CLIENTS)).toEqual(['physical_event', 'video_meeting']);
    expect(defaultEventFormat(PodType.PHYSICAL_EVENT)).toBe('video_meeting');
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
    expect(formatRefusal(PodType.WEBINAR, 'webinar', IN_PERSON_ENABLED_CLIENTS)).toBe("Webinar isn't offered yet.");
    // Asked as production's form asks (no offer), In person is still not offered.
    expect(formatRefusal(PodType.REASON, 'physical_event')).toBe("In person isn't offered yet.");
  });

  it('allows In person in the pod types that hold it, for a caller that offers it, and names the way out elsewhere', () => {
    expect(formatRefusal(PodType.REASON, 'physical_event', IN_PERSON_ENABLED_CLIENTS)).toBeNull();
    expect(formatRefusal(PodType.SPEED_NETWORKING, 'physical_event', IN_PERSON_ENABLED_CLIENTS)).toBeNull();
    expect(formatRefusal(PodType.CHAT, 'physical_event', IN_PERSON_ENABLED_CLIENTS))
      .toBe("In person isn't available in Chat pods. Choose Video meeting.");
    expect(formatRefusal(PodType.WEBINAR, 'physical_event', IN_PERSON_ENABLED_CLIENTS))
      .toBe("In person isn't available in Webinar pods. Choose Video meeting.");
  });
});

describe('fields, defaults and the title', () => {
  it('lists each format’s fields and their defaults', () => {
    expect(fieldsFor('video_meeting')).toEqual(['durationMinutes', 'maxParticipants']);
    expect(defaultsFor('video_meeting')).toEqual({ durationMinutes: 60, maxParticipants: 25 });
    expect(fieldsFor('speed_networking')).toEqual(
      ['numberOfRounds', 'roundMinutes', 'timerVisibility', 'matchingPolicy', 'cooldownMonths', 'matchingTemplateId', 'maxParticipants'],
    );
    // The template has no default: "Default" is simply leaving it empty. The months field starts at 12 on a form.
    expect(defaultsFor('speed_networking')).toEqual({
      numberOfRounds: 5, roundMinutes: 8, timerVisibility: 'last_10s', matchingPolicy: 'within_event', cooldownMonths: 12,
      maxParticipants: 500,
    });
    // A place has no default.
    expect(fieldsFor('physical_event')).toEqual(['location', 'durationMinutes', 'maxParticipants']);
    expect(defaultsFor('physical_event')).toEqual({ durationMinutes: 60, maxParticipants: 25 });
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

  it('refuses a round length of a fraction of a minute (it would store 0 seconds)', () => {
    expect(checkEventInput('speed_networking', { roundMinutes: 0.001 })).toEqual([
      { field: 'roundMinutes', message: 'Round length must be between 1 and 60 minutes.' },
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

  it('checks a place as text: at most 300 characters once trimmed, and text, not a number', () => {
    expect(checkEventInput('physical_event', { location: `  ${'x'.repeat(300)}  `, durationMinutes: 480 })).toEqual([]);
    expect(checkEventInput('physical_event', { location: 'x'.repeat(301) })).toEqual([
      { field: 'location', message: 'Where must be 300 characters or fewer.' },
    ]);
    expect(checkEventInput('physical_event', { location: 42 })).toEqual([
      { field: 'location', message: 'Where must be text.' },
    ]);
    expect(checkEventInput('physical_event', { durationMinutes: 481 })).toEqual([
      { field: 'durationMinutes', message: 'Length must be between 15 and 480 minutes.' },
    ]);
  });
});

describe('missingRequired: what an event cannot be stored without', () => {
  it('an in-person event needs its place; an empty or blank place is missing, in a sentence', () => {
    const missing = [{ field: 'location', message: 'Say where the event happens: an address or a venue.' }];
    expect(missingRequired('physical_event', {})).toEqual(missing);
    expect(missingRequired('physical_event', { location: '   ' })).toEqual(missing);
    expect(missingRequired('physical_event', null)).toEqual(missing);
    expect(missingRequired('physical_event', { location: 'Room 4, Soho House' })).toEqual([]);
  });

  it('nothing else has a required setting', () => {
    expect(missingRequired('speed_networking', {})).toEqual([]);
    expect(missingRequired('video_meeting', {})).toEqual([]);
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

  it('drops a setting that belongs only to another format (a meeting length on speed networking)', () => {
    const out = normaliseConfig('speed_networking', { durationMinutes: 1440, numberOfRounds: 3 });
    expect(out).not.toHaveProperty('durationMinutes');
    expect(out.numberOfRounds).toBe(3);
  });

  it('reads a meeting length the client sent', () => {
    expect(normaliseConfig('video_meeting', { durationMinutes: 90, maxParticipants: 8 }))
      .toEqual({ durationMinutes: 90, maxParticipants: 8, eventType: 'video_meeting' });
  });

  it('stores an in-person event with its place trimmed, and nothing of another format', () => {
    expect(normaliseConfig('physical_event', {
      location: '  The Ivy, 1-5 West St, London  ', durationMinutes: 180, numberOfRounds: 5, roundDurationSeconds: 480,
    })).toEqual({ location: 'The Ivy, 1-5 West St, London', durationMinutes: 180, maxParticipants: 25, eventType: 'physical_event' });
    expect(normaliseConfig('physical_event', { location: '  ' })).toEqual({ durationMinutes: 60, maxParticipants: 25, eventType: 'physical_event' });
  });

  it('never carries a place into speed networking or a video meeting', () => {
    expect(normaliseConfig('speed_networking', { location: 'Soho' })).not.toHaveProperty('location');
    expect(normaliseConfig('video_meeting', { location: 'Soho' })).not.toHaveProperty('location');
  });

  it('stores the months of the cooldown rule only under that rule (12 when not given), so other events are stored as before', () => {
    expect(normaliseConfig('speed_networking', { matchingPolicy: 'cooldown' })).toMatchObject({ matchingPolicy: 'cooldown', cooldownMonths: 12 });
    expect(normaliseConfig('speed_networking', { matchingPolicy: 'cooldown', cooldownMonths: 6 })).toMatchObject({ cooldownMonths: 6 });
    expect(normaliseConfig('speed_networking', { matchingPolicy: 'platform_wide' })).not.toHaveProperty('cooldownMonths');
    expect(normaliseConfig('speed_networking', {})).not.toHaveProperty('cooldownMonths');
  });
});

describe('valuesFromConfig: what an edit form shows', () => {
  it('shows a stored round length in minutes', () => {
    expect(valuesFromConfig('speed_networking', { numberOfRounds: 3, roundDurationSeconds: 150, maxParticipants: 40 }))
      .toEqual({
        numberOfRounds: 3, roundMinutes: 2.5, timerVisibility: 'last_10s', matchingPolicy: 'within_event', cooldownMonths: 12,
        maxParticipants: 40,
      });
  });

  it('shows a meeting’s length and capacity, defaulting what is missing', () => {
    expect(valuesFromConfig('video_meeting', { durationMinutes: 45 })).toEqual({ durationMinutes: 45, maxParticipants: 25 });
  });

  it('shows an in-person event’s place', () => {
    expect(valuesFromConfig('physical_event', { location: 'Soho', durationMinutes: 120 }))
      .toEqual({ location: 'Soho', durationMinutes: 120, maxParticipants: 25 });
  });
});

describe('eventDurationMinutes: one formula for every length (token, calendar, invite)', () => {
  // Hand-computed: rounds × (round + rating) + (rounds − 1) × transition + closing lobby, rounded up to minutes.
  it.each([
    // 5×480 + 5×30 + 4×30 + 120 (the closing lobby's fallback when unset) = 2790 s
    [{}, 47],
    // 3×60 + 3×30 + 2×30 + 120 = 450 s
    [{ numberOfRounds: 3, roundDurationSeconds: 60, ratingWindowSeconds: 30, transitionDurationSeconds: 30, closingLobbyDurationSeconds: 120 }, 8],
    // What a new event is stored with (closing lobby 480): 2400 + 150 + 120 + 480 = 3150 s
    [{ ...DEFAULT_SESSION_CONFIG }, 53],
    // 3600 + 30 + 0 + 120 = 3750 s
    [{ numberOfRounds: 1, roundDurationSeconds: 3600 }, 63],
  ])('speed networking %j lasts %i minutes', (cfg, minutes) => {
    expect(eventDurationMinutes('speed_networking', cfg)).toBe(minutes);
  });

  it('the calendar’s speed-networking length is that formula: a new event lasts 53 minutes', () => {
    expect(computeSessionDurationMinutes({ ...DEFAULT_SESSION_CONFIG })).toBe(53);
  });

  it('is the length for a meeting, its default when unset', () => {
    expect(eventDurationMinutes('physical_event', { durationMinutes: 480 })).toBe(480);
    expect(eventDurationMinutes('physical_event', {})).toBe(60);
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
