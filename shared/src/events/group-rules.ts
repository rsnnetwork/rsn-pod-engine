// ─── Matching groups and round rules (10 Nov 2026 spec, sections 05, 02 and 07) ───────────────────────────
//
// An event may sort its people into groups the organiser names (Founders and Funders, Mentors and Mentees…) and
// say, for each round or run of rounds, who may meet whom. Pure functions, no I/O: the engine, the matching board,
// live redistribution and the organiser's screens read the same rule from here. An event with no groups has no
// rules at all (null), and every caller then behaves exactly as before groups existed.
//
// A group belongs to the event only. It is never read from an account's platform standing or its profile, and it
// grants no permission (spec 05, "Critical distinction").

import type { EventInputIssue } from './rules';

export type RoundRuleMode = 'open' | 'cross_group' | 'custom';

/**
 * Who may meet in rounds `fromRound`..`toRound`: anyone (open), only people of different groups (cross_group), or
 * only the listed pairs of groups (custom). `allowedPairs` entries are `groupPairKey(a, b)`; `'a|a'` lets two
 * people of group a meet.
 */
export interface RoundRule {
  fromRound: number;
  toRound: number;
  mode: RoundRuleMode;
  allowedPairs: string[];
}

/** What happens to people a round's rule leaves without a partner: they wait, or they may meet their own group. */
export type GroupFallback = 'leave_unmatched' | 'same_group_meeting';

export interface EventGroup {
  key: string;
  label: string;
  description?: string | null;
}

/**
 * Who may override this event's group rules (Part 3 Task 12, the product owner's ruling of 11 Nov 2026): the event's
 * owner alone (host_user_id; with super admins, as always), or the owner and the event's co-hosts. Only the owner or a
 * super admin chooses. Every override is audited either way.
 */
export type GroupOverrideBy = 'owner' | 'owner_and_cohosts';

/** The choices, in the order the organiser's form offers them; the first is the rule when nothing was chosen. */
export const GROUP_OVERRIDE_BY: readonly GroupOverrideBy[] = ['owner', 'owner_and_cohosts'];

export interface EventGroupRules {
  groups: EventGroup[];
  /** The required question a participant answers when they register ("Which group are you in?"). */
  question: string;
  /** Whether one person may be in more than one group. */
  allowMultiple: boolean;
  fallback: GroupFallback;
  rounds: RoundRule[];
  /** Who may override the rules (absent = 'owner': the owner and super admins only, the rule before this choice existed). */
  overrideBy?: GroupOverrideBy;
}

/**
 * GET /api/sessions/:id/groups. Everyone who can see the event reads the groups, the question and their own
 * groups (`mine`); the people running it also read the rules, how many people are in each group, and each
 * round's capacity. An event with no groups answers `groups: []`.
 */
export interface EventGroupsView {
  groups: EventGroup[];
  question: string;
  allowMultiple: boolean;
  mine: string[];
  rules?: EventGroupRules | null;
  counts?: Record<string, number>;
  /** People with a place but no group yet (the people running the event left out). */
  ungrouped?: number;
  capacity?: RoundCapacity[];
  /**
   * Each person's group keys, by user id (the people running the event only; people with no group are left out),
   * so the organiser's participant list can show each person's group (Part 2 Task 11).
   */
  members?: Record<string, string[]>;
}

/** The limits the organiser's form and the server hold an event's groups to (the database checks the same). */
export const GROUP_LIMITS = {
  maxGroups: 12,
  keyMaxLength: 32,
  labelMaxLength: 40,
  descriptionMaxLength: 200,
  questionMaxLength: 120,
} as const;

export const DEFAULT_GROUP_QUESTION = 'Which group are you in?';

const KEY_PATTERN = /^[a-z0-9_]{1,32}$/;

/** A group key as stored: lower-case letters, digits and underscores, 1 to 32 of them. */
export function isGroupKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** The one name of a pair of groups, whichever way round it is given: 'founder|funder'. */
export function groupPairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/** The rule for a round: the range that covers it, else open (a round no range covers has no restriction). */
export function ruleForRound(rules: EventGroupRules, round: number): RoundRule {
  const covering = rules.rounds.find((r) => round >= r.fromRound && round <= r.toRound);
  return covering ?? { fromRound: round, toRound: round, mode: 'open', allowedPairs: [] };
}

/**
 * Whether two people with these groups may meet under this rule. Open: always. Across groups: some group of one
 * differs from some group of the other (someone in both groups meets either). Custom: some combination of their
 * groups is a listed pair. Someone with no group meets anyone only in an open round.
 */
export function groupsAllowed(rule: RoundRule, groupsA: readonly string[], groupsB: readonly string[]): boolean {
  if (rule.mode === 'open') return true;
  if (groupsA.length === 0 || groupsB.length === 0) return false;
  if (rule.mode === 'cross_group') return groupsA.some((ga) => groupsB.some((gb) => ga !== gb));
  const allowed = new Set(rule.allowedPairs);
  return groupsA.some((ga) => groupsB.some((gb) => allowed.has(groupPairKey(ga, gb))));
}

// ─── The organiser's input ───────────────────────────────────────────────────

function checkGroups(rules: EventGroupRules): EventInputIssue[] {
  const issues: EventInputIssue[] = [];
  if (rules.groups.length === 0) issues.push({ field: 'groups', message: 'Add at least one group.' });
  if (rules.groups.length > GROUP_LIMITS.maxGroups) {
    issues.push({ field: 'groups', message: `An event can have at most ${GROUP_LIMITS.maxGroups} groups.` });
  }
  const seen = new Set<string>();
  rules.groups.forEach((g, i) => {
    if (!isGroupKey(g.key)) {
      issues.push({ field: `groups.${i}.key`, message: 'A group needs a short name made of letters and numbers.' });
    } else if (seen.has(g.key)) {
      issues.push({ field: `groups.${i}.key`, message: 'Two groups have the same name.' });
    }
    seen.add(g.key);
    const label = (g.label ?? '').trim();
    if (label.length === 0 || label.length > GROUP_LIMITS.labelMaxLength) {
      issues.push({ field: `groups.${i}.label`, message: `Give the group a name of 1 to ${GROUP_LIMITS.labelMaxLength} characters.` });
    }
    if (g.description && g.description.length > GROUP_LIMITS.descriptionMaxLength) {
      issues.push({ field: `groups.${i}.description`, message: `Keep the description to ${GROUP_LIMITS.descriptionMaxLength} characters.` });
    }
  });
  const question = (rules.question ?? '').trim();
  if (question.length === 0 || question.length > GROUP_LIMITS.questionMaxLength) {
    issues.push({ field: 'question', message: `Ask the group question in 1 to ${GROUP_LIMITS.questionMaxLength} characters.` });
  }
  return issues;
}

function checkPairs(rule: RoundRule, i: number, keys: Set<string>): EventInputIssue[] {
  if (rule.mode !== 'custom') return [];
  if (rule.allowedPairs.length === 0) {
    return [{ field: `rounds.${i}.allowedPairs`, message: 'Choose at least one pair of groups who may meet.' }];
  }
  const unknown = rule.allowedPairs.some((pair) => {
    const parts = pair.split('|');
    return parts.length !== 2 || !keys.has(parts[0]) || !keys.has(parts[1]);
  });
  return unknown ? [{ field: `rounds.${i}.allowedPairs`, message: 'A pair names a group this event does not have.' }] : [];
}

function checkRounds(rules: EventGroupRules, numberOfRounds: number): EventInputIssue[] {
  const issues: EventInputIssue[] = [];
  const keys = new Set(rules.groups.map((g) => g.key));
  rules.rounds.forEach((r, i) => {
    const whole = Number.isInteger(r.fromRound) && Number.isInteger(r.toRound);
    if (!whole || r.fromRound < 1 || r.toRound < r.fromRound) {
      issues.push({ field: `rounds.${i}`, message: 'A rule covers a run of rounds from a first round to a last one.' });
    } else if (r.toRound > numberOfRounds) {
      issues.push({
        field: `rounds.${i}`,
        message: `This event has ${numberOfRounds} rounds, so a rule can cover rounds 1 to ${numberOfRounds} only.`,
      });
    }
    if (r.mode === 'cross_group' && rules.groups.length < 2) {
      issues.push({ field: `rounds.${i}.mode`, message: 'Meeting across groups needs at least two groups.' });
    }
    issues.push(...checkPairs(r, i, keys));
  });
  // Overlaps, in the order the organiser wrote the rules: each range against every earlier one.
  rules.rounds.forEach((r, i) => {
    const earlier = rules.rounds.slice(0, i).find((e) => r.fromRound <= e.toRound && e.fromRound <= r.toRound);
    if (earlier) {
      issues.push({
        field: `rounds.${i}`,
        message: `Rounds ${r.fromRound} to ${r.toRound} overlap rounds ${earlier.fromRound} to ${earlier.toRound}.`,
      });
    }
  });
  return issues;
}

/**
 * Everything wrong with an organiser's groups and round rules, said at the field: 1 to 12 groups with distinct
 * well-formed keys and labels, a question, ranges inside the event's rounds that do not overlap, custom pairs that
 * name the event's own groups, and at least two groups for meeting across groups.
 */
export function validateGroupRules(rules: EventGroupRules, numberOfRounds: number): EventInputIssue[] {
  return [...checkGroups(rules), ...checkRounds(rules, numberOfRounds)];
}

// ─── Presets ─────────────────────────────────────────────────────────────────

export type GroupPresetId =
  | 'founders_funders' | 'teachers_pupils' | 'employers_candidates' | 'mentors_mentees' | 'buyers_vendors';

/** A preset's groups and question; its rounds are "every round across groups", made into a range for the event. */
export type GroupPreset = Omit<EventGroupRules, 'rounds'> & { rounds: 'all_cross_group' };

function twoSided(a: EventGroup, b: EventGroup, question: string): GroupPreset {
  return { groups: [a, b], question, allowMultiple: false, fallback: 'leave_unmatched', rounds: 'all_cross_group' };
}

export const GROUP_PRESETS: Record<GroupPresetId, GroupPreset> = {
  founders_funders: twoSided({ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }, 'Are you a founder or a funder?'),
  teachers_pupils: twoSided({ key: 'teacher', label: 'Teachers' }, { key: 'pupil', label: 'Pupils' }, 'Are you a teacher or a pupil?'),
  employers_candidates: twoSided(
    { key: 'employer', label: 'Employers' }, { key: 'candidate', label: 'Candidates' }, 'Are you hiring or looking for a role?',
  ),
  mentors_mentees: twoSided({ key: 'mentor', label: 'Mentors' }, { key: 'mentee', label: 'Mentees' }, 'Are you a mentor or a mentee?'),
  // Part 3 Task 12: vendor matching, beside the other two-sided types.
  buyers_vendors: twoSided({ key: 'buyer', label: 'Buyers' }, { key: 'vendor', label: 'Vendors' }, 'Are you buying or selling?'),
};

// ─── Capacity: how many meetings a round's rule allows ──────────────────────

export interface RoundCapacity {
  round: number;
  /** The most meetings (pairs) the rule allows in this round. */
  maxMeetings: number;
  /** People of each group left without an allowed partner (groups where nobody waits are left out). */
  waiting: Record<string, number>;
  /** Groups whose people cannot avoid meeting someone twice over the rounds that use this rule. */
  repeatsUnavoidableFor: string[];
  /**
   * People with a place but no group yet whom this round cannot place: every one of them under a rule that
   * restricts who meets (a rule only lets groups meet), none in an open round (everyone pairs there).
   */
  ungrouped: number;
  /** The organiser's sentence when somebody waits (in a group, or for want of one), else null. */
  sentence: string | null;
}

/** Max flow (Edmonds-Karp) on a small dense graph; returns the flow on each edge. At most 26 nodes here. */
function maxFlow(capacity: number[][], source: number, sink: number): number[][] {
  const n = capacity.length;
  const flow = capacity.map((row) => row.map(() => 0));
  for (;;) {
    const parent = new Array<number>(n).fill(-1);
    parent[source] = source;
    const queue = [source];
    while (queue.length > 0 && parent[sink] === -1) {
      const u = queue.shift() as number;
      for (let v = 0; v < n; v++) {
        if (parent[v] === -1 && capacity[u][v] - flow[u][v] > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[sink] === -1) return flow;
    let push = Infinity;
    for (let v = sink; v !== source; v = parent[v]) push = Math.min(push, capacity[parent[v]][v] - flow[parent[v]][v]);
    for (let v = sink; v !== source; v = parent[v]) {
      flow[parent[v]][v] += push;
      flow[v][parent[v]] -= push;
    }
  }
}

/** Two colours for the allowed-pair graph, or null when it is not two-sided (an odd cycle or a group meeting itself). */
function twoColour(keys: string[], allowed: (a: string, b: string) => boolean): Map<string, 0 | 1> | null {
  const colour = new Map<string, 0 | 1>();
  for (const start of keys) {
    if (colour.has(start)) continue;
    colour.set(start, 0);
    const stack = [start];
    while (stack.length > 0) {
      const g = stack.pop() as string;
      for (const h of keys) {
        if (!allowed(g, h)) continue;
        if (g === h) return null;
        const want = colour.get(g) === 0 ? 1 : 0;
        if (!colour.has(h)) {
          colour.set(h, want);
          stack.push(h);
        } else if (colour.get(h) !== want) {
          return null;
        }
      }
    }
  }
  return colour;
}

/** The people of each group the rule can seat: exact for a two-sided rule, halved from the doubled flow otherwise. */
function matchedPerGroup(keys: string[], counts: number[], allowed: (a: string, b: string) => boolean): { meetings: number; matched: number[] } {
  const k = keys.length;
  const total = counts.reduce((s, c) => s + c, 0);
  // Doubled network: source, each group on the left, each group again on the right, sink.
  const source = 0;
  const sink = 2 * k + 1;
  const cap = Array.from({ length: 2 * k + 2 }, () => new Array<number>(2 * k + 2).fill(0));
  for (let g = 0; g < k; g++) {
    cap[source][1 + g] = counts[g];
    cap[1 + k + g][sink] = counts[g];
    for (let h = 0; h < k; h++) if (allowed(keys[g], keys[h])) cap[1 + g][1 + k + h] = total + 1;
  }
  const flow = maxFlow(cap, source, sink);
  const doubled = flow[source].reduce((s, f) => s + Math.max(0, f), 0);
  const meetings = Math.floor(doubled / 2);

  const colour = twoColour(keys.filter((_, g) => counts[g] > 0), allowed);
  if (colour) {
    // Two-sided: one side to the other carries exactly one unit per meeting, so each group's seated people are whole.
    const one = Array.from({ length: k + 2 }, () => new Array<number>(k + 2).fill(0));
    for (let g = 0; g < k; g++) {
      if (counts[g] === 0) continue;
      if (colour.get(keys[g]) === 0) {
        one[0][1 + g] = counts[g];
        for (let h = 0; h < k; h++) if (counts[h] > 0 && allowed(keys[g], keys[h])) one[1 + g][1 + h] = total + 1;
      } else {
        one[1 + g][k + 1] = counts[g];
      }
    }
    const f = maxFlow(one, 0, k + 1);
    const matched = keys.map((key, g) => (colour.get(key) === 0 ? Math.max(0, f[0][1 + g]) : Math.max(0, f[1 + g][k + 1])));
    return { meetings, matched };
  }
  const matched = keys.map((_, g) => Math.floor((Math.max(0, flow[source][1 + g]) + Math.max(0, flow[1 + k + g][sink])) / 2));
  return { meetings, matched };
}

/** The rounds of the event that use the same rule as this round: its range, or every round no range covers. */
function roundsUsingRule(rules: EventGroupRules, round: number, numberOfRounds: number): number {
  const covering = rules.rounds.find((r) => round >= r.fromRound && round <= r.toRound);
  if (covering) return Math.max(0, Math.min(covering.toRound, numberOfRounds) - covering.fromRound + 1);
  let uncovered = 0;
  for (let r = 1; r <= numberOfRounds; r++) {
    if (!rules.rounds.some((x) => r >= x.fromRound && r <= x.toRound)) uncovered++;
  }
  return uncovered;
}

const lower = (label: string) => label.trim().toLowerCase();
/** "Founders" → "founder", "Funder" → "funder". Labels are usually plural nouns; one that is not reads as it is. */
function singular(label: string): string {
  const l = lower(label);
  return l.length > 3 && l.endsWith('s') && !l.endsWith('ss') ? l.slice(0, -1) : l;
}
function plural(label: string): string {
  const l = lower(label);
  return l.endsWith('s') ? l : `${l}s`;
}
function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capacitySentence(
  rules: EventGroupRules, rule: RoundRule, keys: string[], maxMeetings: number, waiting: Record<string, number>,
): string | null {
  const waitingKeys = keys.filter((key) => waiting[key] > 0);
  if (waitingKeys.length === 0) return null;
  const labelOf = (key: string) => rules.groups.find((g) => g.key === key)?.label ?? key;
  // "8 founder and funder meetings" when the rule allows exactly one pair of two different groups; else "8 meetings".
  const pairs = rule.mode === 'cross_group'
    ? (keys.length === 2 ? [[keys[0], keys[1]]] : [])
    : rule.allowedPairs.map((p) => p.split('|'));
  const only = pairs.length === 1 && pairs[0][0] !== pairs[0][1] ? pairs[0] : null;
  const kinds = only ? `${singular(labelOf(only[0]))} and ${singular(labelOf(only[1]))} ` : '';
  const who = andList(waitingKeys.map((key) => `${waiting[key]} ${waiting[key] === 1 ? singular(labelOf(key)) : plural(labelOf(key))}`));
  const total = waitingKeys.reduce((s, key) => s + waiting[key], 0);
  const own = waitingKeys.length === 1 ? `another ${singular(labelOf(waitingKeys[0]))}` : 'someone from their own group';
  return `In each round at most ${maxMeetings} ${kinds}meetings are possible, so ${who} ${total === 1 ? 'waits' : 'wait'}. `
    + `Choose: leave them unmatched, or let them meet ${own}.`;
}

/** People with a place but no group: a rule that restricts who meets cannot place them. */
function ungroupedSentence(n: number): string | null {
  if (n === 0) return null;
  return `${n} ${n === 1 ? 'person has' : 'people have'} no group yet, so this round cannot match them until they are put in a group.`;
}

/**
 * How many meetings this round's rule allows for these group sizes, who waits, which groups must meet someone
 * twice, and the sentence the organiser reads. Open: everyone pairs (an odd one joins a trio). Otherwise a flow on
 * the groups (source → group → allowed partner group → sink, each side capped by the group's size): half the flow
 * is the most meetings, exact for a two-sided rule and an upper bound otherwise, hence "at most". People in more
 * than one group are counted in each.
 */
export function explainRoundCapacity(
  rules: EventGroupRules, round: number, groupCounts: Record<string, number>, numberOfRounds: number,
  /** People with a place but no group yet: they meet anyone in an open round and nobody under a restricting rule. */
  ungroupedCount = 0,
): RoundCapacity {
  const rule = ruleForRound(rules, round);
  const keys = rules.groups.map((g) => g.key);
  const counts = keys.map((key) => Math.max(0, Math.floor(groupCounts[key] ?? 0)));
  const ungrouped = Math.max(0, Math.floor(ungroupedCount));
  const allowed = (a: string, b: string) => groupsAllowed(rule, [a], [b]);
  const rounds = roundsUsingRule(rules, round, numberOfRounds);
  const open = rule.mode === 'open';
  const partnerPool = (g: number) => keys.reduce((s, key, h) => s + (allowed(keys[g], key) ? counts[h] - (h === g ? 1 : 0) : 0), 0)
    + (open ? ungrouped : 0);
  const repeatsUnavoidableFor = keys.filter((_, g) => counts[g] > 0 && rounds > partnerPool(g));

  if (open) {
    const n = counts.reduce((s, c) => s + c, 0) + ungrouped;
    return { round, maxMeetings: Math.floor(n / 2), waiting: {}, repeatsUnavoidableFor, ungrouped: 0, sentence: null };
  }
  const { meetings, matched } = matchedPerGroup(keys, counts, allowed);
  const waiting: Record<string, number> = {};
  keys.forEach((key, g) => {
    const left = counts[g] - matched[g];
    if (left > 0) waiting[key] = left;
  });
  return {
    round,
    maxMeetings: meetings,
    waiting,
    repeatsUnavoidableFor,
    ungrouped,
    sentence: [capacitySentence(rules, rule, keys, meetings, waiting), ungroupedSentence(ungrouped)]
      .filter((x): x is string => x !== null).join(' ') || null,
  };
}

// ─── The round's rule, said to the organiser ────────────────────────────────

/**
 * What a round's rule allows, as the end of the organiser's sentence when a room breaks it ("Ann and Bob can't meet
 * in this round: everyone meets someone from another group."). Labels are the organiser's own group names.
 */
export function roundRuleSentence(rules: EventGroupRules, round: number): string {
  const rule = ruleForRound(rules, round);
  if (rule.mode === 'open') return 'anyone may meet anyone.';
  if (rule.mode === 'cross_group') return 'everyone meets someone from another group.';
  const labelOf = (key: string) => rules.groups.find((g) => g.key === key)?.label.trim() ?? key;
  const pairs = rule.allowedPairs.map((p) => {
    const [a, b] = p.split('|');
    return a === b ? `${labelOf(a)} with each other` : `${labelOf(a)} with ${labelOf(b)}`;
  });
  return `only ${andList(pairs)} may meet.`;
}
