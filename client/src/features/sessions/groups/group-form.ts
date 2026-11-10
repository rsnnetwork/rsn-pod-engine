// ─── Matching groups on the event page: the form's values and the small pure steps (Part 2 Task 11; spec 05, 07) ────
// Pure (shared only), so the client test runs it. What is valid is the shared validateGroupRules' (the server checks
// the same); what each round allows is the shared explainRoundCapacity's, so the organiser reads the same sentence the
// matcher works from.
import { z } from 'zod';
import type { FieldErrors, Resolver } from 'react-hook-form';
import {
  DEFAULT_GROUP_QUESTION, GROUP_LIMITS, GROUP_PRESETS, explainRoundCapacity, groupPairKey, validateGroupRules,
  type EventGroup, type EventGroupRules, type GroupFallback, type GroupPresetId, type RoundRule, type RoundRuleMode,
} from '@rsn/shared';

export const GROUPS_COPY = {
  title: 'Matching groups',
  hint: 'Sort people into groups and say who meets whom in each round.',
  none: 'No groups: everyone can meet everyone.',
  setUp: 'Set up groups',
  edit: 'Edit groups',
  remove: 'Remove groups',
  removeTitle: 'Remove the groups?',
  removeBody: "Everyone's group is cleared and every round lets anyone meet anyone again.",
  removed: 'Groups removed.',
  saved: 'Groups saved.',
  save: 'Save groups',
  presetLegend: 'Start from',
  groupsLegend: 'Groups',
  addGroup: 'Add a group',
  groupName: (n: number) => `Group ${n} name`,
  removeGroup: (label: string) => `Remove ${label || 'this group'}`,
  question: 'The question people answer when they register',
  allowMultiple: 'One person may be in more than one group',
  roundsLegend: 'Who meets whom',
  roundsHint: 'Rounds no rule covers let everyone meet.',
  addRule: 'Add rounds',
  removeRule: 'Remove these rounds',
  from: 'From round',
  to: 'To round',
  mode: 'In these rounds',
  pairsLegend: 'Who may meet',
  fallbackLegend: 'When groups are uneven:',
  dropsPeopleTitle: 'Some people lose their group',
  dropsPeopleBody: 'A group that has people in it is not in the new list, so they will have no group until they are put in one.',
  dropsPeopleConfirm: 'Save anyway',
  ungrouped: (n: number) => `${n} ${n === 1 ? 'person has' : 'people have'} no group yet.`,
  members: (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`,
  error: 'The groups could not be read just now.',
  fallback: 'That did not go through. Please try again.',
  changeGroup: 'Change group',
  changeTitle: (name: string) => `${name}'s group`,
  changeSave: 'Save',
  changed: 'Group changed.',
  noGroup: 'No group',
  chooseGroup: 'Choose a group.',
} as const;

export type PresetChoice = GroupPresetId | 'custom';

export const PRESET_OPTIONS: ReadonlyArray<{ id: PresetChoice; label: string }> = [
  { id: 'founders_funders', label: 'Founders and funders' },
  { id: 'teachers_pupils', label: 'Teachers and pupils' },
  { id: 'employers_candidates', label: 'Employers and candidates' },
  { id: 'mentors_mentees', label: 'Mentors and mentees' },
  { id: 'custom', label: 'Custom' },
];

export const RULE_MODE_OPTIONS: ReadonlyArray<{ mode: RoundRuleMode; label: string }> = [
  { mode: 'open', label: 'Everyone can meet' },
  { mode: 'cross_group', label: 'Only different groups meet' },
  { mode: 'custom', label: 'Choose pairs' },
];

export const FALLBACK_OPTIONS: ReadonlyArray<{ value: GroupFallback; label: string }> = [
  { value: 'leave_unmatched', label: 'Leave people unmatched' },
  { value: 'same_group_meeting', label: 'Let them meet their own group' },
];

/** The form's values: the groups keep their keys (a saved group keeps its people when it is renamed). */
export interface GroupFormValues {
  preset: PresetChoice;
  groups: Array<{ key: string; label: string }>;
  question: string;
  allowMultiple: boolean;
  fallback: GroupFallback;
  rounds: RoundRule[];
}

const everyRound = (numberOfRounds: number): RoundRule[] =>
  [{ fromRound: 1, toRound: Math.max(1, numberOfRounds), mode: 'cross_group', allowedPairs: [] }];

/** A preset as the form's values for an event of this many rounds: its groups, its question, every round across groups. */
export function presetValues(id: PresetChoice, numberOfRounds: number): GroupFormValues {
  if (id === 'custom') {
    return {
      preset: 'custom', groups: [{ key: '', label: '' }, { key: '', label: '' }], question: DEFAULT_GROUP_QUESTION,
      allowMultiple: false, fallback: 'leave_unmatched', rounds: everyRound(numberOfRounds),
    };
  }
  const p = GROUP_PRESETS[id];
  return {
    preset: id,
    groups: p.groups.map((g) => ({ key: g.key, label: g.label })),
    question: p.question,
    allowMultiple: p.allowMultiple,
    fallback: p.fallback,
    rounds: everyRound(numberOfRounds),
  };
}

/** Which preset saved rules came from (their group keys, in order), else Custom. */
export function presetOf(rules: Pick<EventGroupRules, 'groups'>): PresetChoice {
  const keys = rules.groups.map((g) => g.key).join(',');
  const found = (Object.keys(GROUP_PRESETS) as GroupPresetId[]).find((id) => GROUP_PRESETS[id].groups.map((g) => g.key).join(',') === keys);
  return found ?? 'custom';
}

/** The form's starting values: the saved rules, or Founders and funders over every round for an event with none. */
export function formValuesOf(rules: EventGroupRules | null | undefined, numberOfRounds: number): GroupFormValues {
  if (!rules || rules.groups.length === 0) return presetValues('founders_funders', numberOfRounds);
  return {
    preset: presetOf(rules),
    groups: rules.groups.map((g) => ({ key: g.key, label: g.label })),
    question: rules.question,
    allowMultiple: rules.allowMultiple,
    fallback: rules.fallback,
    rounds: rules.rounds.map((r) => ({ ...r, allowedPairs: [...r.allowedPairs] })),
  };
}

/** A key for a new group, from its name: lower-case letters, digits and '_', never one already taken. */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  let base = '';
  for (const ch of label.trim().toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) base += ch;
    else if (base && !base.endsWith('_')) base += '_';
    if (base.length >= GROUP_LIMITS.keyMaxLength - 3) break;
  }
  while (base.endsWith('_')) base = base.slice(0, -1);
  if (!base) base = 'group';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

/**
 * The form's groups with a key each: a saved group keeps its own, a new one is given one from its name (the same
 * every time for the same names, so a pair chosen for a new group still names it when the form is saved).
 */
export function keyedGroups(groups: GroupFormValues['groups']): EventGroup[] {
  const taken = new Set(groups.map((g) => g.key).filter(Boolean));
  return groups.map((g) => {
    if (g.key) return { key: g.key, label: g.label.trim() };
    const key = keyFromLabel(g.label, taken);
    taken.add(key);
    return { key, label: g.label.trim() };
  });
}

/** The form as the rules the server stores: new groups get keys from their names; pairs that name a removed group go. */
export function rulesOfForm(values: GroupFormValues): EventGroupRules {
  const groups = keyedGroups(values.groups);
  const keys = new Set(groups.map((g) => g.key));
  return {
    groups,
    question: values.question.trim() || DEFAULT_GROUP_QUESTION,
    allowMultiple: values.allowMultiple,
    fallback: values.fallback,
    rounds: values.rounds.map((r) => ({
      fromRound: Number(r.fromRound),
      toRound: Number(r.toRound),
      mode: r.mode,
      allowedPairs: r.mode === 'custom' ? r.allowedPairs.filter((p) => p.split('|').every((k) => keys.has(k))) : [],
    })),
  };
}

/** Every problem with the form, keyed by the field it is about (the shared validator's own field names). */
export function formIssues(values: GroupFormValues, numberOfRounds: number): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const issue of validateGroupRules(rulesOfForm(values), numberOfRounds)) {
    if (!(issue.field in issues)) issues[issue.field] = issue.message;
  }
  return issues;
}

/** The pairs a "Choose pairs" rule can name: every two groups, and each group with itself. */
export function pairOptions(groups: ReadonlyArray<{ key: string; label: string }>): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  groups.forEach((a, i) => {
    groups.slice(i).forEach((b) => {
      out.push({ key: groupPairKey(a.key, b.key), label: a.key === b.key ? `${a.label} with each other` : `${a.label} with ${b.label}` });
    });
  });
  return out;
}

export interface CapacityLine {
  /** "Round 2" or "Rounds 1 to 3". */
  rounds: string;
  sentence: string;
}

/**
 * Each affected round's sentence from explainRoundCapacity, for these group sizes. Rounds side by side that say the
 * same are one line ("Rounds 1 to 3"); rounds where everyone has someone to meet say nothing.
 */
export function capacityLines(
  rules: EventGroupRules, counts: Record<string, number>, ungrouped: number, numberOfRounds: number,
): CapacityLine[] {
  if (rules.groups.length === 0) return [];
  const lines: Array<{ from: number; to: number; sentence: string }> = [];
  for (let round = 1; round <= numberOfRounds; round++) {
    const sentence = explainRoundCapacity(rules, round, counts, numberOfRounds, ungrouped).sentence;
    if (!sentence) continue;
    const last = lines[lines.length - 1];
    if (last && last.to === round - 1 && last.sentence === sentence) last.to = round;
    else lines.push({ from: round, to: round, sentence });
  }
  return lines.map((l) => ({ rounds: l.from === l.to ? `Round ${l.from}` : `Rounds ${l.from} to ${l.to}`, sentence: l.sentence }));
}

/** Saved groups with people in them that the new rules leave out (their people would lose their group). */
export function droppedGroupsWithPeople(before: EventGroupRules | null | undefined, after: EventGroupRules, counts: Record<string, number>): string[] {
  if (!before) return [];
  const kept = new Set(after.groups.map((g) => g.key));
  return before.groups.filter((g) => !kept.has(g.key) && (counts[g.key] ?? 0) > 0).map((g) => g.label);
}

/** One rule in the organiser's words, for the card's summary: "Rounds 1 to 3: Only different groups meet". */
export function ruleLine(rule: RoundRule, groups: ReadonlyArray<{ key: string; label: string }>): string {
  const span = rule.fromRound === rule.toRound ? `Round ${rule.fromRound}` : `Rounds ${rule.fromRound} to ${rule.toRound}`;
  if (rule.mode !== 'custom') return `${span}: ${RULE_MODE_OPTIONS.find((o) => o.mode === rule.mode)?.label ?? ''}`;
  const names = pairOptions(groups).filter((p) => rule.allowedPairs.includes(p.key)).map((p) => p.label);
  return `${span}: ${names.join(', ')}`;
}

// ─── The form's check: Zod for the shape, the shared validator for the rules ──────────────────────────────

/** The form's schema for an event of this many rounds: each shared validator issue is raised at its own field. */
export function groupFormSchema(numberOfRounds: number) {
  return z.object({
    preset: z.enum(['founders_funders', 'teachers_pupils', 'employers_candidates', 'mentors_mentees', 'custom']),
    groups: z.array(z.object({ key: z.string(), label: z.string().max(GROUP_LIMITS.labelMaxLength, `Keep a group's name to ${GROUP_LIMITS.labelMaxLength} characters.`) })),
    question: z.string().max(GROUP_LIMITS.questionMaxLength, `Ask the group question in 1 to ${GROUP_LIMITS.questionMaxLength} characters.`),
    allowMultiple: z.boolean(),
    fallback: z.enum(['leave_unmatched', 'same_group_meeting']),
    rounds: z.array(z.object({
      fromRound: z.coerce.number().int(),
      toRound: z.coerce.number().int(),
      mode: z.enum(['open', 'cross_group', 'custom']),
      allowedPairs: z.array(z.string()),
    })),
  }).superRefine((values, ctx) => {
    for (const [field, message] of Object.entries(formIssues(values, numberOfRounds))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: field.split('.').map((seg) => (seg !== '' && /^\d+$/.test(seg) ? Number(seg) : seg)) });
    }
  });
}

type ErrorNode = { type?: string; message?: string; [key: string]: unknown };

/** react-hook-form's resolver over that schema: the first problem at each full field path ("rounds.1.mode"). */
export function groupFormResolver(numberOfRounds: number): Resolver<GroupFormValues> {
  const schema = groupFormSchema(numberOfRounds);
  return async (values) => {
    const parsed = schema.safeParse(values);
    if (parsed.success) return { values: parsed.data as GroupFormValues, errors: {} };
    const errors: Record<string, ErrorNode> = {};
    for (const issue of parsed.error.issues) {
      let node: Record<string, unknown> = errors;
      issue.path.forEach((seg, i) => {
        const key = String(seg);
        const next = (node[key] ?? {}) as ErrorNode;
        if (i === issue.path.length - 1 && next.message === undefined) Object.assign(next, { type: issue.code, message: issue.message });
        node[key] = next;
        node = next;
      });
    }
    return { values: {}, errors: errors as FieldErrors<GroupFormValues> };
  };
}

/** The message at a field path of react-hook-form's errors, if there is one. */
export function messageAt(errors: unknown, path: string): string | undefined {
  let node: unknown = errors;
  for (const seg of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  const message = node && typeof node === 'object' ? (node as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : undefined;
}
