// Stefan, 9 Jun — a new user invited to an event clicked the magic link from
// their email (a different tab/browser/phone than the login screen) and landed
// on the dashboard instead of the event. Root cause: the redirect intent lived
// only in the login tab's sessionStorage (`rsn_redirect`), which doesn't exist
// in the email-click context, and the magic-link URL didn't carry the invite
// code — so VerifyPage fell back to '/'. Fix: embed inviteCode IN the magic-link
// URL (like the Google-OAuth path already does) so VerifyPage routes the new
// user to /invite/:code → accept → into the event.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const serverSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('Magic-link invite redirect (new user reaches the event)', () => {
  it('the magic-link URL embeds the invite code when one is present', () => {
    const svc = serverSrc('services/identity/identity.service.ts');
    expect(svc).toMatch(
      /inviteCode\s*\?\s*`\$\{clientBaseUrl\}\/auth\/verify\?token=\$\{token\}&inviteCode=\$\{encodeURIComponent\(inviteCode\)\}`/,
    );
  });

  it('VerifyPage routes to /invite/:code using the URL inviteCode param', () => {
    const verify = clientSrc('features/auth/VerifyPage.tsx');
    expect(verify).toMatch(/const inviteCode = params\.get\('inviteCode'\)/);
    expect(verify).toMatch(/inviteCode \? `\/invite\/\$\{inviteCode\}`/);
  });
});
