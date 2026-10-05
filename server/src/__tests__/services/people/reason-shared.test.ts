import * as fs from 'fs';
import * as path from 'path';
import {
  primaryActionFor, OUTCOME_KEYS, OUTCOME_LABELS, MEETING_FORMATS, PERSON_RESPONSES, WORTH_CONTINUING,
  type PrimaryAction, type RelationshipState,
} from '@rsn/shared';

// One entry per relationship state. It is a Record, so a state added to RelationshipState without
// an entry here does not compile, the same as a primaryActionFor that forgets it.
const OFFERED: Record<RelationshipState, PrimaryAction> = {
  none: 'meet',
  requested: 'requested',
  incoming: 'respond',
  declined: 'declined',
  connected: 'continue',
  met: 'continue',
};

describe('REASON shared vocabulary (milestone 1)', () => {
  it.each(Object.entries(OFFERED) as Array<[RelationshipState, PrimaryAction]>)('state %s offers %s', (state, action) => {
    expect(primaryActionFor(state)).toBe(action);
  });

  it('a state this build does not know still offers Meet, as the old default did', () => {
    // A newer server can send a state that an older client bundle has no case for.
    expect(primaryActionFor('not-a-state' as unknown as RelationshipState)).toBe('meet');
  });

  it('outcomes are exactly the Foundation S10 list, each with a label', () => {
    expect([...OUTCOME_KEYS]).toEqual([
      'follow_up', 'introduction', 'potential_customer', 'potential_partnership',
      'advice', 'investment', 'hiring', 'friendship', 'nothing_yet',
    ]);
    for (const k of OUTCOME_KEYS) expect(OUTCOME_LABELS[k]).toBeTruthy();
  });

  it('meeting formats are the three the v4 prototype offers', () => {
    expect(MEETING_FORMATS.map(f => f.label)).toEqual([
      '20 minute video conversation', 'In person coffee', 'Message first',
    ]);
  });

  it('a member can Save or Pass, and rate a meeting yes, maybe or no', () => {
    expect([...PERSON_RESPONSES]).toEqual(['saved', 'passed']);
    expect([...WORTH_CONTINUING]).toEqual(['yes', 'maybe', 'no']);
  });
});

// Jest maps @rsn/shared to shared/src, where `export *` works, so a value that has no named
// re-export in index.ts passes every test here and is `undefined` only in the client bundle,
// which cannot see through `export *`. So read the two files.
describe('every value in types/reason.ts has its own named re-export in the shared index', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../../shared/src', rel), 'utf8');
  const reason = read('types/reason.ts');
  const index = read('index.ts');
  // Types are erased at build time, so only values need a re-export (a function counts, like primaryActionFor).
  const values = [...reason.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map((m) => m[1]);
  // What index.ts imports from './types/reason', keyed by the alias it re-exports it under.
  const importedAs = new Map<string, string>(
    [...index.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/types\/reason'/g)]
      .flatMap((block) => [...block[1].matchAll(/(\w+)\s+as\s+(\w+)/g)])
      .map((m): [string, string] => [m[2], m[1]]),
  );

  it('finds the values it is meant to guard', () => {
    expect(values).toEqual(expect.arrayContaining([
      'MEETING_FORMATS', 'OUTCOME_KEYS', 'OUTCOME_LABELS', 'PERSON_RESPONSES', 'WORTH_CONTINUING', 'primaryActionFor',
    ]));
  });

  it.each(values)('%s', (name) => {
    const reexport = index.match(new RegExp(`^export const ${name}\\s*=\\s*(\\w+)\\s*;`, 'm'));
    expect({ name, reexported: reexport !== null }).toEqual({ name, reexported: true });
    // ...and it is wired to the right thing, not to a neighbour.
    expect(importedAs.get(reexport![1])).toBe(name);
  });
});
