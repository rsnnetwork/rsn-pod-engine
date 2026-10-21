// server/src/__tests__/client/profile-photo-upload.test.ts
// The photo upload on the profile form (21 Oct 2026). A phone photo of 1.5 to 5 MB left "Uploading..." on
// screen for good: the upload was awaited inside reader.onload, outside the try, so the server's refusal (the
// 2,000,000-character cap on avatarUrl) was never caught, no toast said anything and nothing put the button
// back. The photo is now made smaller in the browser before it is sent, and every way the upload can end
// says so and puts the button back.
//
// The page needs a browser to run, so its wiring is read from the source; the words a failure gets are worked
// out by a pure function, which is cut out of the file and run. The e2e spec presses the button for real.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';

const FILE = path.join(__dirname, '../../../../client/src/features/profile/ProfilePage.tsx');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const src = () => fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

/** The source of one top-level function or arrow in the page, from its first line to its closing brace. */
function cut(start: string, end: string): string {
  const s = src();
  const from = s.indexOf(start);
  if (from < 0) throw new Error(`ProfilePage.tsx has no "${start}"`);
  const to = s.indexOf(end, from);
  if (to < 0) throw new Error(`"${start}" in ProfilePage.tsx does not end with "${end}"`);
  return s.slice(from, to + end.length);
}
const handler = () => cut('const handleAvatarUpload = async', '\n  };\n');

/** photoUploadError, transpiled and run on its own: it must need nothing from the rest of the page. */
function photoUploadError(err: unknown): string {
  const fn = cut('function photoUploadError(', '\n}\n');
  const { outputText } = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2019 } });
  const run = vm.runInNewContext(`(function () { ${outputText}\n return photoUploadError; })()`) as (e: unknown) => string;
  return run(err);
}

describe('profile photo: what is sent', () => {
  it('is the photo made at most 800 by 800, as a JPEG at quality 0.85', () => {
    expect(src()).toMatch(/const PHOTO_MAX_SIDE = 800;/);
    expect(src()).toMatch(/const PHOTO_QUALITY = 0\.85;/);
    expect(src()).toMatch(/Math\.min\(1, PHOTO_MAX_SIDE \/ img\.naturalWidth, PHOTO_MAX_SIDE \/ img\.naturalHeight\)/);
    expect(src()).toMatch(/canvas\.toDataURL\('image\/jpeg', PHOTO_QUALITY\)/);
  });

  it('is never the file as it was read: the upload sends the smaller picture', () => {
    expect(handler()).toMatch(/const avatarUrl = await shrinkPhoto\(file\);\s*await api\.put\('\/users\/me', \{ avatarUrl \}\);/);
    expect(handler()).not.toMatch(/readAsDataURL|reader\.onload/);
  });

  it('a transparent PNG turns white, not black, when it becomes a JPEG', () => {
    expect(cut('async function shrinkPhoto(', '\n}\n')).toMatch(/fillStyle = '#ffffff';\s*ctx\.fillRect\(0, 0, width, height\);\s*ctx\.drawImage\(img, 0, 0, width, height\);/);
  });

  it('the decoded picture is let go of once it is drawn (the object URL is revoked)', () => {
    const load = cut('function loadImage(', '\n}\n');
    expect(load).toMatch(/URL\.createObjectURL\(file\)/);
    expect((load.match(/URL\.revokeObjectURL\(url\)/g) ?? []).length).toBe(2);
  });
});

describe('profile photo: however the upload ends', () => {
  it('everything that can fail is awaited inside one try, so a refusal is caught', () => {
    expect(handler()).toMatch(/setAvatarUploading\(true\);\s*try \{\s*const avatarUrl = await shrinkPhoto\(file\);[\s\S]*await api\.put\('\/users\/me'[\s\S]*\} catch \(err\) \{\s*addToast\(photoUploadError\(err\), 'error'\);\s*\} finally \{\s*setAvatarUploading\(false\);\s*\}/);
  });

  it('"Uploading..." is put back in one place only, the finally, so no path can leave it on screen', () => {
    expect((handler().match(/setAvatarUploading\(false\)/g) ?? []).length).toBe(1);
    expect(handler()).not.toMatch(/onload = async|onerror = /);
  });

  it('the same photo can be chosen again after a failure', () => {
    expect(handler()).toMatch(/input\.value = '';/);
  });

  it('refuses a wrong type, or a file over 20 MB, before anything is read', () => {
    expect(handler()).toMatch(/addToast\('Please upload a JPG, PNG, or WebP image', 'error'\);\s*return;/);
    // 20 MB, as the banner allows: the photo is made smaller before it is sent, so a phone photo of 5 to 20 MB is fine.
    expect(handler()).toMatch(/file\.size > 20 \* 1024 \* 1024/);
    expect(handler()).toMatch(/addToast\('Image must be under 20MB', 'error'\);\s*return;/);
    expect(handler()).not.toMatch(/5 \* 1024 \* 1024|under 5MB/);
  });
});

describe('profile photo: what a failure says', () => {
  it('the server\'s own sentence, as it sent it', () => {
    expect(photoUploadError({ response: { status: 429, data: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.' } } } }))
      .toBe('Too many requests. Please try again later.');
    expect(photoUploadError({ response: { status: 500, data: { error: { message: 'An unexpected error occurred' } } } }))
      .toBe('An unexpected error occurred');
  });

  it('never the form check\'s label: on a photo "Validation failed" only ever means it is too large', () => {
    expect(photoUploadError({ response: { status: 400, data: { error: { message: 'Validation failed', details: { avatarUrl: ['String must contain at most 2000000 character(s)'] } } } } }))
      .toBe('That photo is too large. Please choose a smaller one.');
  });

  it('plain words when the server answered without a sentence', () => {
    for (const data of [{}, { error: {} }, { error: { message: '   ' } }, { error: { message: 42 } }, '<html>502</html>']) {
      expect(photoUploadError({ response: { status: 502, data } })).toBe('Could not update your photo. Please try again.');
    }
  });

  it('the connection, when the request got no answer at all', () => {
    expect(photoUploadError({ isAxiosError: true, code: 'ERR_NETWORK', request: {} }))
      .toBe('Could not update your photo. Check your connection and try again.');
  });

  it('that the photo could not be read, when the browser could not open the picture', () => {
    expect(photoUploadError(new Error('This picture could not be read'))).toBe('We could not read that photo. Please choose another one.');
    expect(photoUploadError(undefined)).toBe('We could not read that photo. Please choose another one.');
  });
});
