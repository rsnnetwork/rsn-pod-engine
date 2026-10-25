// ─── The one definition of event formats and pod types (26 Oct 2026) ─────────────────────────────
//
// 25 Oct walkthrough: a member chose "Video Meeting" for a Reason pod's event and the server ran it as speed
// networking (a round plan at Go Live, round controls, a "people met / avg rating" recap), because "event
// format" existed only as a client list and nothing tied it to the pod type. There is now one editable
// definition in shared/src/events/definitions.ts: every create and edit screen reads it and the server
// enforces it. Shradha amends a row; this file fails on any edit that leaves the table inconsistent.

import * as fs from 'fs';
import * as path from 'path';
import {
  EVENT_FORMATS, EVENT_FORMAT_KEYS, POD_TYPES, ORCHESTRATION_MODES,
  PodType, OrchestrationMode, CommunicationMode, DEFAULT_SESSION_CONFIG,
} from '@rsn/shared';

const LIVE_KINDS = ['rounds', 'meeting', 'none'];
const formatKeys = Object.keys(EVENT_FORMATS);
const podTypeKeys = Object.keys(POD_TYPES);

describe('event formats', () => {
  it('has exactly one row per format key, and the key list is the five formats', () => {
    expect([...EVENT_FORMAT_KEYS].sort()).toEqual(
      ['physical_event', 'speed_networking', 'video_meeting', 'voice_meeting', 'webinar'],
    );
    expect(formatKeys.sort()).toEqual([...EVENT_FORMAT_KEYS].sort());
  });

  it.each(formatKeys)('%s has a label, a one-line summary and known live and recap kinds', (key) => {
    const rule = EVENT_FORMATS[key as keyof typeof EVENT_FORMATS];
    expect(rule.label.trim()).not.toBe('');
    expect(rule.summary.trim()).not.toBe('');
    expect(LIVE_KINDS).toContain(rule.live);
    expect(['ratings', 'attendance']).toContain(rule.recap);
    expect(typeof rule.available).toBe('boolean');
    expect(typeof rule.breakouts).toBe('boolean');
  });

  it.each(formatKeys)('%s: ratings, breakouts and a matching engine belong to rounds only', (key) => {
    const rule = EVENT_FORMATS[key as keyof typeof EVENT_FORMATS];
    if (rule.recap === 'ratings') expect(rule.live).toBe('rounds');
    if (rule.breakouts) expect(rule.live).toBe('rounds');
    expect(rule.matchingEngineId !== null).toBe(rule.live === 'rounds');
  });

  it('offers a format only when the live engine has a way to run it (rounds or a meeting room)', () => {
    for (const rule of Object.values(EVENT_FORMATS)) {
      if (rule.available) expect(['rounds', 'meeting']).toContain(rule.live);
    }
  });

  it.each(formatKeys)('%s: every field has a label, a default (unless an admin-only pick) and limits that hold the default', (key) => {
    const rule = EVENT_FORMATS[key as keyof typeof EVENT_FORMATS];
    const entries = Object.entries(rule.fields);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, field] of entries) {
      expect(`${name}: ${field.label.trim()}`).not.toBe(`${name}: `);
      if (field.adminOnly) continue;
      expect(field.default).toBeDefined();
      if (typeof field.default === 'number') {
        expect(typeof field.min).toBe('number');
        expect(typeof field.max).toBe('number');
        expect(field.min!).toBeLessThanOrEqual(field.default);
        expect(field.default).toBeLessThanOrEqual(field.max!);
      } else {
        expect(Array.isArray(field.options)).toBe(true);
        expect(field.options).toContain(field.default);
      }
    }
  });

  it('holds the values of the definition sheet (audit 03 §8)', () => {
    const sn = EVENT_FORMATS.speed_networking;
    expect(sn).toMatchObject({
      label: 'Speed networking', live: 'rounds', available: true, recap: 'ratings', breakouts: true,
      matchingEngineId: 'speed_networking_v1',
    });
    expect(sn.fields.numberOfRounds).toMatchObject({ default: 5, min: 1, max: 20 });
    expect(sn.fields.roundMinutes).toMatchObject({ default: 8, min: 1, max: 60 });
    expect(sn.fields.timerVisibility).toMatchObject({ default: 'last_10s' });
    expect(sn.fields.matchingPolicy).toMatchObject({ default: 'within_event' });
    expect(sn.fields.matchingTemplateId).toMatchObject({ adminOnly: true });
    expect(sn.fields.maxParticipants).toMatchObject({ default: 500, min: 2, max: 10000 });

    const vm = EVENT_FORMATS.video_meeting;
    expect(vm).toMatchObject({
      label: 'Video meeting', live: 'meeting', available: true, recap: 'attendance', breakouts: false,
      matchingEngineId: null,
    });
    expect(Object.keys(vm.fields).sort()).toEqual(['durationMinutes', 'maxParticipants']);
    expect(vm.fields.durationMinutes).toMatchObject({ default: 60, min: 15, max: 240 });
    expect(vm.fields.maxParticipants).toMatchObject({ default: 25, min: 2, max: 100 });

    expect(EVENT_FORMATS.voice_meeting.available).toBe(false);
    expect(EVENT_FORMATS.webinar.available).toBe(false);
    expect(EVENT_FORMATS.physical_event.available).toBe(false);
  });

  it('agrees with the speed-networking defaults the engine already uses, so a new event runs as before', () => {
    const f = EVENT_FORMATS.speed_networking.fields;
    expect(f.numberOfRounds.default).toBe(DEFAULT_SESSION_CONFIG.numberOfRounds);
    expect((f.roundMinutes.default as number) * 60).toBe(DEFAULT_SESSION_CONFIG.roundDurationSeconds);
    expect(f.timerVisibility.default).toBe(DEFAULT_SESSION_CONFIG.timerVisibility);
    expect(f.matchingPolicy.default).toBe(DEFAULT_SESSION_CONFIG.matchingPolicy);
    expect(f.maxParticipants.default).toBe(DEFAULT_SESSION_CONFIG.maxParticipants);
    expect(EVENT_FORMATS.speed_networking.matchingEngineId).toBe(DEFAULT_SESSION_CONFIG.matchingAlgorithmId);
  });
});

describe('pod types', () => {
  it('has exactly one row per pod type', () => {
    expect(podTypeKeys.sort()).toEqual(Object.values(PodType).sort());
  });

  it.each(podTypeKeys)('%s has a label, a summary, a communication mode and a sensible size hint', (key) => {
    const rule = POD_TYPES[key as PodType];
    expect(rule.label.trim()).not.toBe('');
    expect(rule.summary.trim()).not.toBe('');
    expect(Object.values(CommunicationMode)).toContain(rule.communication);
    if (rule.sizeHint !== null) {
      expect(Number.isInteger(rule.sizeHint)).toBe(true);
      expect(rule.sizeHint).toBeGreaterThan(1);
    }
  });

  it.each(podTypeKeys)('%s: the orchestration default is one of its allowed modes, all of them real modes', (key) => {
    const { orchestration } = POD_TYPES[key as PodType];
    expect(orchestration.allowed.length).toBeGreaterThan(0);
    expect(new Set(orchestration.allowed).size).toBe(orchestration.allowed.length);
    for (const mode of orchestration.allowed) expect(Object.values(OrchestrationMode)).toContain(mode);
    expect(orchestration.allowed).toContain(orchestration.default);
  });

  it.each(podTypeKeys)('%s: the event default is allowed and offered, and every allowed format is a known one', (key) => {
    const { events } = POD_TYPES[key as PodType];
    expect(new Set(events.allowed).size).toBe(events.allowed.length);
    for (const format of events.allowed) expect(EVENT_FORMAT_KEYS).toContain(format);
    expect(events.allowed).toContain(events.default);
    // No unavailable format as a default: an organiser must be able to create the event the form preselects.
    expect(EVENT_FORMATS[events.default].available).toBe(true);
  });

  it('holds the Reason pod row of the definition sheet', () => {
    expect(POD_TYPES[PodType.REASON]).toEqual({
      label: 'Reason Pod',
      summary: expect.any(String),
      orchestration: { default: OrchestrationMode.FREE_FORM, allowed: [OrchestrationMode.FREE_FORM, OrchestrationMode.MODERATED] },
      events: { default: 'video_meeting', allowed: ['video_meeting', 'speed_networking'] },
      communication: CommunicationMode.VIDEO,
      sizeHint: 12,
    });
  });

  it('a speed-networking pod still defaults to timed rounds and speed networking', () => {
    expect(POD_TYPES[PodType.SPEED_NETWORKING].orchestration.default).toBe(OrchestrationMode.TIMED_ROUNDS);
    expect(POD_TYPES[PodType.SPEED_NETWORKING].events.default).toBe('speed_networking');
  });
});

describe('orchestration modes', () => {
  it('names every mode, with a summary and the phrase a notice uses', () => {
    expect(Object.keys(ORCHESTRATION_MODES).sort()).toEqual(Object.values(OrchestrationMode).sort());
    for (const mode of Object.values(ORCHESTRATION_MODES)) {
      expect(mode.label.trim()).not.toBe('');
      expect(mode.summary.trim()).not.toBe('');
      expect(mode.phrase.trim()).not.toBe('');
    }
    expect(ORCHESTRATION_MODES[OrchestrationMode.FREE_FORM].label).toBe('Freeform');
    expect(ORCHESTRATION_MODES[OrchestrationMode.TIMED_ROUNDS].phrase).toBe('timed rounds');
  });
});

describe('the shared index exports each value by name (Rollup reads only static exports)', () => {
  const index = fs.readFileSync(path.join(__dirname, '../../../../shared/src/index.ts'), 'utf8');
  it.each([
    'EVENT_FORMATS', 'EVENT_FORMAT_KEYS', 'POD_TYPES', 'ORCHESTRATION_MODES',
    'formatRule', 'podTypeRule', 'isEventFormat', 'liveKindOf', 'effectiveOrchestration', 'eventFormatsForPod',
    'defaultEventFormat', 'fieldsFor', 'defaultsFor', 'defaultTitle', 'checkEventInput', 'normaliseConfig',
    'valuesFromConfig', 'eventDurationMinutes', 'applyTypeChange', 'applyFormatChange', 'resolveEventFormat', 'formatRefusal',
  ])('%s', (name) => {
    expect(index).toMatch(new RegExp(`\\nexport const ${name} = `));
  });
});
