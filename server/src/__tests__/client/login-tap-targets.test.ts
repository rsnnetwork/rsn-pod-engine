// server/src/__tests__/client/login-tap-targets.test.ts
//
// Every control on the sign-in page is a 44px touch target (19 Oct feedback). Measured in a browser at 360 to 1440
// while the page's words were changed: "Request to Join" was 40px tall, the email field 42px from 640px up (its text
// drops to text-sm there), and "Try a different email" about 20px. The client has no test runner of its own, so, like
// its neighbours in this folder, this reads the source.

import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../../../client');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

describe('The sign-in page: every control is a 44px touch target (19 Oct feedback)', () => {
  const login = () => read('src/features/auth/LoginPage.tsx');

  it('Continue with Google, the email field, Request to Join and Try a different email carry min-h-[44px]', () => {
    expect(login()).toMatch(/onClick=\{handleGoogleLogin\}[^>]*className="[^"]*\bmin-h-\[44px\]/);
    expect(login()).toMatch(/<Input\s[^>]*type="email"[^>]*className="min-h-\[44px\]"/);
    expect(login()).toMatch(/onClick=\{\(\) => navigate\('\/request-to-join'\)\}\s*className="[^"]*\bmin-h-\[44px\]/);
    expect(login()).toMatch(/onClick=\{\(\) => setSent\(false\)\} className="[^"]*\bmin-h-\[44px\]/);
  });

  it('Send magic link is a medium Button, whose own minimum height is 44px', () => {
    expect(login()).toMatch(/<Button type="submit" className="w-full group" isLoading=\{isSubmitting\}>/);
    expect(read('src/components/ui/Button.tsx')).toMatch(/md: '[^']*\bmin-h-\[44px\]'/);
  });
});
