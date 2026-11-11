// ─── Part 3 Task 13: who may override the group rules, and Buyers and vendors (client side of Task 12) ───────────────
// The pure form module is run; the components are pinned by their source: the copy, the owner-only tiles, the
// read-only line for everyone else, 44px tiles, the shared query tag (no setQueryData) and the preset in both pickers.

import * as fs from 'fs';
import * as path from 'path';
import { GROUP_PRESETS, MATCHING_PRESET_IDS } from '@rsn/shared';
import {
  GROUPS_COPY, OVERRIDE_OPTIONS, PRESET_OPTIONS, groupFormSchema, presetValues,
} from '../../../../client/src/features/sessions/groups/group-form';
import { isPresetId } from '../../../../client/src/features/sessions/event-format-form';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const SETTING = read('features/sessions/groups/OverrideSetting.tsx');
const CARD = read('features/sessions/groups/EventGroupsCard.tsx');
const HOOKS = read('features/sessions/groups/useEventGroups.ts');
const SETTINGS = read('features/sessions/OrganiserSettings.tsx');
const DETAIL = read('features/sessions/SessionDetailPage.tsx');
const MATCHING = read('features/sessions/MatchingSection.tsx');

describe('Who can override these rules', () => {
  it('uses the agreed words', () => {
    expect(GROUPS_COPY.overrideLegend).toBe('Who can override these rules');
    expect(OVERRIDE_OPTIONS).toEqual([
      { value: 'owner', label: 'Only me' },
      { value: 'owner_and_cohosts', label: 'Me and my co-hosts' },
    ]);
    expect(GROUPS_COPY.overrideReadOnly).toBe("Only the event's owner can change who may override these rules.");
  });

  it('shows the tiles to the owner only and the read-only line to everyone else', () => {
    expect(SETTING).toMatch(/canChoose \? \(/);
    expect(SETTING).toContain('type="radio"');
    expect(SETTING).toContain('GROUPS_COPY.overrideReadOnly');
    expect(SETTING).toContain('GROUPS_COPY.overrideNow(current)');
    // The read-only branch has no radio input.
    const readOnly = SETTING.slice(SETTING.indexOf('data-testid="override-readonly"'));
    expect(readOnly).not.toContain('type="radio"');
  });

  it('makes each tile at least 44px tall and fits 360px', () => {
    expect(SETTING).toContain('min-h-[44px]');
    expect(SETTING).toContain('min-w-0');
    expect(SETTING).not.toMatch(/\bw-\[\d+px\]/);
  });

  it('saves through the groups write and the groups query, never by hand', () => {
    expect(SETTING).not.toContain('setQueryData');
    expect(HOOKS).not.toContain('setQueryData');
    expect(HOOKS).toContain('...(rules.overrideBy ? { overrideBy: rules.overrideBy } : {})');
    expect(HOOKS).toContain('E.sessionGroups(sessionId)');
  });

  it('only the owner or a super admin is handed the tiles', () => {
    expect(DETAIL).toContain("mayChooseOverride={isHost || user?.role === 'super_admin'}");
    expect(SETTINGS).toContain('mayChooseOverride={mayChooseOverride}');
    expect(CARD).toContain('canChoose={mayChooseOverride}');
  });

  it('the editor and Remove groups never send the stored choice back', () => {
    expect(CARD).toContain('overrideBy: undefined');
  });
});

describe('Buyers and vendors', () => {
  it('is a group preset tile that fills Buyers and Vendors', () => {
    expect(PRESET_OPTIONS.find((p) => p.id === 'buyers_vendors')?.label).toBe('Buyers and vendors');
    const v = presetValues('buyers_vendors', 4);
    expect(v.groups.map((g) => g.label)).toEqual(['Buyers', 'Vendors']);
    expect(v.question).toBe(GROUP_PRESETS.buyers_vendors.question);
    expect(v.rounds).toEqual([{ fromRound: 1, toRound: 4, mode: 'cross_group', allowedPairs: [] }]);
  });

  it('the form accepts the preset', () => {
    const parsed = groupFormSchema(4).safeParse(presetValues('buyers_vendors', 4));
    expect(parsed.success).toBe(true);
  });

  it('is a matching style an organiser may choose, listed from the server like the other four', () => {
    expect(isPresetId(MATCHING_PRESET_IDS.buyersVendors)).toBe(true);
    expect(MATCHING_PRESET_IDS.buyersVendors).toBe('5e7b1a5e-0000-4000-8000-000000000005');
    expect(MATCHING).toContain('(presets.data ?? []).map((p) => (');
    expect(MATCHING).toContain('{p.name}');
    expect(MATCHING).toContain('{p.description');
    // The loading skeleton is as tall as five presets.
    expect(MATCHING).toContain('isAdmin ? 6 : 5');
  });
});
