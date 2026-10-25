// ─── The made-up people the tour's pictures show (25 Oct 2026, ONB-05) ───────
//
// Stefan and Claus, 25 Oct: the pictures may show people again, as long as it is clear they are made up,
// with English names. One list, in shared, so the preview's tour (task C2) and the live tour (task L1)
// show the same people. Each name was checked read-only against the members' display names before it was
// chosen: a made-up person who shares a real member's name would defeat the label.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { EXAMPLE_PEOPLE } from '@rsn/shared';

describe('EXAMPLE_PEOPLE', () => {
  it('is the six people the review agreed, in order, with their roles', () => {
    expect(EXAMPLE_PEOPLE).toEqual([
      { name: 'Emma Clarke', role: 'Product manager' },
      { name: 'James Hughes', role: 'Founder' },
      { name: 'Olivia Bennett', role: 'Investor' },
      { name: 'Daniel Walsh', role: 'Head of sales' },
      { name: 'Hannah Moore', role: 'Freelance designer' },
      { name: 'Thomas Reid', role: 'Engineering lead' },
    ]);
  });

  it('never brings back the people the old pictures showed, or their companies', () => {
    const words = EXAMPLE_PEOPLE.map((p) => `${p.name} ${p.role}`).join(' ');
    expect(words).not.toMatch(/Amara|Okafor|Tomas|Lind\b|Priya|Raman|Northwind|Baltic/);
  });

  // The client bundler (Rollup, through Vite) cannot see a value through the loop `export *` compiles to,
  // so a value the client imports needs its own plain `exports.X = ...` (see the note in shared/src/index.ts).
  it('is a plain value export of the package root, which the client bundler can import', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../../../../shared/src/index.ts'), 'utf8');
    const emitted = ts.transpileModule(index, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    expect(emitted).toMatch(/^exports\.EXAMPLE_PEOPLE = \w+\.EXAMPLE_PEOPLE;\r?$/m);
  });
});
