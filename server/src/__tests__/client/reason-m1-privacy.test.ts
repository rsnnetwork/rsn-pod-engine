// server/src/__tests__/client/reason-m1-privacy.test.ts
// Approved point 1 (29 Sep 2026): until the per-reason share switch exists, no
// REASON screen may show another member's wants.
import * as fs from 'fs';
import * as path from 'path';

const dir = path.join(__dirname, '../../../../client/src/features/reason');
const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]);

describe('REASON screens never show another member\'s wants', () => {
  it('no "They need" or "You can bring" labels anywhere in features/reason', () => {
    for (const f of files(dir).filter(f => /\.tsx?$/.test(f))) {
      const src = fs.readFileSync(f, 'utf8');
      expect({ f, hit: /They need|You can bring/.test(src) }).toEqual({ f, hit: false });
    }
  });
  it('the card shows the other person\'s offer and the viewer\'s own want', () => {
    const card = fs.readFileSync(path.join(dir, 'human/HumanCard.tsx'), 'utf8');
    expect(card).toMatch(/They can bring/);
    expect(card).toMatch(/You are looking for/);
    expect(card).toMatch(/primaryActionFor/);
  });
});
