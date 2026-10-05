// server/src/__tests__/client/reason-m1-look.test.ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../../../client');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

describe('REASON look (milestone 1)', () => {
  it('Tailwind carries the prototype palette with the accessible brand red', () => {
    const tw = read('tailwind.config.js');
    expect(tw).toMatch(/reason:\s*\{/);
    expect(tw).toMatch(/red: '#DE322E'/);
    expect(tw).toMatch(/ink: '#11131a'/);
  });
  it('sheep poses are web-sized (<= 200KB each)', () => {
    for (const pose of ['match', 'curious', 'hopeful', 'thinking']) {
      const size = fs.statSync(path.join(root, `public/sheep/v4/${pose}.png`)).size;
      expect(size).toBeLessThanOrEqual(200 * 1024);
    }
  });
  it('the logo is the official sheep mark, not a prototype crop', () => {
    const mark = read('src/features/reason/brand/ReasonMark.tsx');
    expect(mark).toMatch(/\/rsn-sheep\.png/);
    expect(mark).not.toMatch(/logo_mark|logo_crop/);
  });
  it('sheets portal to body, are real dialogs, and respect the iPhone home bar', () => {
    const sheet = read('src/features/reason/ui/Sheet.tsx');
    expect(sheet).toMatch(/createPortal\([\s\S]*document\.body/);
    expect(sheet).toMatch(/role="dialog"/);
    expect(sheet).toMatch(/aria-modal="true"/);
    expect(sheet).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(sheet).toMatch(/h-11 w-11/);
  });
});
