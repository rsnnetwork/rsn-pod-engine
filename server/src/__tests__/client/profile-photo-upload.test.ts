// server/src/__tests__/client/profile-photo-upload.test.ts
// The photo upload on the profile form (21 Oct 2026; through the picture editor since the 30 Oct review, T3a).
// 21 Oct: a phone photo of 1.5 to 5 MB left "Uploading..." on screen for good, because the server's refusal was never
// caught. 30 Oct: the form's own 800px shrink is gone. The pencil (and "Change photo") open the picture editor; the
// picture the member chose is sent as it is when the server keeps it as it is, or as a smaller copy made in halving
// steps with the browser's best smoothing (the one-step shrink made uploads jagged), and the server cuts the 1024
// square. Every way a save can end is said in the editor, which keeps its Save busy until it has.
//
// The pages need a browser to run, so their wiring is read from the source. The e2e spec presses everything for real.
import * as fs from 'fs';
import * as path from 'path';

const CLIENT = path.join(__dirname, '../../../../client/src');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const form = () => read('features/profile/ProfilePage.tsx');
const prepare = () => read('components/picture/prepare-picture.ts');
const editor = () => read('components/picture/PictureEditor.tsx');
const hook = () => read('components/picture/useMemberPicture.ts');

describe('profile photo: where it is changed on the form', () => {
  it('the pencil on the photo and "Change photo" open the same editor; nothing on the form shows only on hover', () => {
    expect(form()).toMatch(/const photo = useMemberPicture\('avatar'\);/);
    expect(form()).toMatch(/<PencilButton label="Edit photo" onClick=\{photo\.edit\} disabled=\{photo\.busy\}/);
    expect(form()).toMatch(/onClick=\{photo\.edit\}\s*disabled=\{photo\.busy\}[\s\S]*\{photo\.busy \? 'Saving\.\.\.' : 'Change photo'\}/);
    expect(form()).toMatch(/<PictureEditor \{\.\.\.photo\.editor\} \/>/);
    expect(form()).not.toMatch(/group-hover:opacity-100/);
    expect(form()).not.toMatch(/shrinkPhoto|PHOTO_MAX_SIDE|handleAvatarUpload/);
  });
});

describe('profile photo: what is sent', () => {
  it('the picture as it is when the server keeps it as it is, else a smaller copy that fits 3 MB and 4096 pixels', () => {
    expect(prepare()).toMatch(/if \(!drawCopy && sendsAsItIs\(file, \{ width: img\.naturalWidth, height: img\.naturalHeight \}\)\) \{\s*return \{ image: await readAsDataUrl\(file\), copied: false \};/);
    expect(prepare()).toMatch(/for \(const side of \[PICTURE_SEND_MAX_SIDE, 3072, 2048\]\)/);
    expect(prepare()).toMatch(/if \(bytesIn\(copy\) <= PICTURE_SEND_MAX_BYTES\) return \{ image: copy, copied: true \};/);
  });

  it('a smaller copy is shrunk in halving steps with the best smoothing, never in one low-quality step', () => {
    expect(prepare()).toMatch(/ctx\.imageSmoothingQuality = 'high';/);
    expect(prepare()).toMatch(/while \(w \/ 2 >= width && h \/ 2 >= height\)/);
  });

  it('a transparent PNG turns white, not black, when it becomes a JPEG', () => {
    expect(prepare()).toMatch(/ctx\.fillStyle = '#ffffff';\s*ctx\.fillRect\(0, 0, width, height\);\s*ctx\.drawImage\(source, 0, 0, width, height\);/);
  });

  it('the decoded picture is let go of once it is read (the object URL is revoked either way)', () => {
    const open = prepare().slice(prepare().indexOf('function openPicture('), prepare().indexOf('function canvasOf('));
    expect(open).toMatch(/URL\.createObjectURL\(file\)/);
    expect((open.match(/URL\.revokeObjectURL\(url\)/g) ?? []).length).toBe(2);
  });

  it('a picture is sent with where it was placed, and a crop alone places the kept picture again', () => {
    // T15 review I1: through the one save step, which sends { crop } alone or { image, crop } (picture-send.test.ts).
    expect(hook()).toMatch(/sendPicture\(picture, crop, \(body\) => savePictureRequest\(kind, body\), pictureToSend\)/);
    const helper = read('components/picture/send-picture.ts');
    expect(helper).toMatch(/if \(!picture\) return send\(\{ crop \}\);/);
    expect(helper).toMatch(/return await send\(\{ image: first\.image, crop \}\);/);
  });
});

describe('profile photo: however a save ends', () => {
  it('everything that can fail is awaited inside one try, said in the editor, and Save is given back in the finally only', () => {
    expect(editor()).toMatch(/setBusy\(true\);\s*setError\(null\);\s*try \{\s*await onSave\([\s\S]*\} catch \(err\) \{[\s\S]*setError\([\s\S]*\} finally \{\s*setBusy\(false\);\s*\}/);
    expect((editor().match(/setBusy\(false\)/g) ?? []).length).toBe(1);
  });

  it('a picture the browser cannot read, or one too large, says so in its own words; anything else in the server\'s words', () => {
    expect(editor()).toMatch(/\[UNREADABLE_PICTURE, PICTURE_TOO_LARGE\]\.includes\(err\.message\)/);
    // T15 review M6: the sentence names the picture through `named`, which is still "your {name}" for a member's.
    expect(editor()).toMatch(/const named = subject \?\? `your \$\{name\}`;/);
    expect(editor()).toMatch(/errorMessage\(err, `Could not save \$\{named\} right now\. Try again in a moment\.`\)/);
    expect(prepare()).toMatch(/export const UNREADABLE_PICTURE = 'We could not read that picture\. Please choose another one\.';/);
  });

  it('the same picture can be chosen again after a failure, and a wrong type or a file over 20 MB is refused before it is read', () => {
    expect(editor()).toMatch(/e\.target\.value = '';/);
    expect(editor()).toMatch(/const problem = pictureFileProblem\(file, name, named\);/);
  });

  it('after a save the header photo is the new one (the session is read again) and the card is refreshed, before the editor closes', () => {
    expect(hook()).toMatch(/kind === 'avatar' \? checkSession\(\) : undefined/);
    expect(hook()).toMatch(/\]\);\s*setOpen\(false\);/);
  });
});
