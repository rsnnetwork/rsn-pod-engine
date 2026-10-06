// server/src/__tests__/client/avatar-failed-photo.test.ts
// A photo that fails to load shows the initials, even when it fails at once.
//
// Avatar used to reset its "broken" flag in an effect, and that effect runs after the first render. An
// error that arrived before it (a photo that fails at once: an invalid data: URL, an instant 404 on WebKit)
// was undone, and the browser's broken-image glyph and alt text stayed on screen (found 7 Oct 2026, while
// checking the REASON person card). The behaviour was proved in a browser, in Chromium and WebKit: an
// invalid data: URL, an instant 404, a 404 after 300 ms, a working photo, and a src that changes from
// broken to working. Jest has no browser, so these pins keep the shape that makes it true.
import * as fs from 'fs';
import * as path from 'path';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const avatar = () => fs.readFileSync(path.join(__dirname, '../../../../client/src/components/ui/Avatar.tsx'), 'utf8').replace(/\r\n/g, '\n');

describe('Avatar: a photo that fails shows the initials', () => {
  it('remembers WHICH photo failed and compares it with the current src, so a new src is tried again', () => {
    expect(avatar()).toMatch(/const \[failedSrc, setFailedSrc\] = useState<string \| null>\(null\);/);
    expect(avatar()).toMatch(/if \(src && src !== failedSrc\) \{/);
    expect(avatar()).toMatch(/onError=\{\(\) => setFailedSrc\(src\)\}/);
  });

  it('has no effect that resets the failure after mount (it undid an error that came first)', () => {
    expect(avatar()).not.toMatch(/useEffect/);
    expect(avatar()).not.toMatch(/setBroken/);
  });

  it('still falls back to the initials of the name, in the same box', () => {
    expect(avatar()).toMatch(/bg-brand-600 flex items-center justify-center font-semibold text-white/);
    expect(avatar()).toMatch(/\{getInitials\(name\)\}/);
  });
});
