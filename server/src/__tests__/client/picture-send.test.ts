// ─── One save step for every picture (T15 client review I1 and M6, 1 Nov 2026) ──────────────────────────────────
// The member's photo and banner (T3a's useMemberPicture) and an entity's logo and banner (T15's useEntityPicture)
// save the same way: only the crop when the picture is the one they had; else the file as it is (or a smaller copy);
// and when the server says it cannot open the original, once more a copy the browser draws, never a copy of a copy.
// That rule now lives once, in send-picture.ts's sendPicture, and is run here with a stand-in for the browser's
// part. The editor's sentences name the picture as its owner reads it: "your photo" for a member, "the logo" for a
// company's.

import * as fs from 'fs';
import * as path from 'path';
import { sendPicture, type PictureSend } from '../../../../client/src/components/picture/send-picture';
import { pictureFileProblem } from '../../../../client/src/components/picture/picture-file';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

const CROP = { x: 0.4, y: 0.5, zoom: 2 };
const cannotOpen = { response: { status: 400, data: { error: { code: 'VALIDATION_ERROR', message: 'That file is not a picture we can use. Choose a JPG, PNG or WebP picture.' } } } };
const picture = new Blob(['x']);

/** The browser's part, stood in: the original as it is, or (drawCopy) a copy drawn on a canvas. */
const prepare = jest.fn(async (_file: Blob, drawCopy = false) => ({ image: drawCopy ? 'data:drawn' : 'data:original', copied: drawCopy }));

beforeEach(() => prepare.mockClear());

describe('sendPicture', () => {
  it('sends only the crop for the picture they had (no file), and prepares nothing', async () => {
    const send = jest.fn(async (body: PictureSend) => body);
    expect(await sendPicture(null, CROP, send, prepare)).toEqual({ crop: CROP });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('sends a new picture as it is, with its crop', async () => {
    const send = jest.fn(async (body: PictureSend) => body);
    expect(await sendPicture(picture, CROP, send, prepare)).toEqual({ image: 'data:original', crop: CROP });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('when the server cannot open the original, sends once more the copy the browser draws', async () => {
    const send = jest.fn(async (body: PictureSend) => { if (body.image === 'data:original') throw cannotOpen; return body; });
    expect(await sendPicture(picture, CROP, send, prepare)).toEqual({ image: 'data:drawn', crop: CROP });
    expect(prepare.mock.calls.map((c) => c[1] ?? false)).toEqual([false, true]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never sends a copy of a copy: a first send that was already a copy is not tried again', async () => {
    const copied = jest.fn(async () => ({ image: 'data:smaller', copied: true }));
    const send = jest.fn(async () => { throw cannotOpen; });
    await expect(sendPicture(picture, CROP, send, copied)).rejects.toBe(cannotOpen);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('any other refusal (too big, slow down, offline) is passed on and not tried again', async () => {
    for (const err of [
      { response: { status: 400, data: { error: { message: 'The logo must be 3 MB or smaller.' } } } },
      { response: { status: 429, data: { error: { message: 'Slow down a moment, then try again.' } } } },
      { request: {}, code: 'ERR_NETWORK' },
    ]) {
      const send = jest.fn(async () => { throw err; });
      await expect(sendPicture(picture, CROP, send, prepare)).rejects.toBe(err);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('is the one save step: both hooks call it, and neither carries its own copy of the rule', () => {
    for (const hook of ['components/picture/useMemberPicture.ts', 'features/reason/entities/useEntityPicture.ts']) {
      const text = read(hook);
      expect({ hook, calls: /sendPicture\(picture, crop, \(body\) => \w+\([^)]*body\), pictureToSend\)/.test(text) }).toEqual({ hook, calls: true });
      expect({ hook, own: /pictureToSend\(|serverCouldNotOpen\(|first\.copied/.test(text) }).toEqual({ hook, own: false });
    }
  });
});

describe('the editor names a company\'s picture as "the logo", not "your logo" (review M6)', () => {
  it('pictureFileProblem takes how the picture is named; a member\'s still reads "your photo"', () => {
    expect(pictureFileProblem({ type: 'image/gif', size: 10 }, 'photo')).toBe('Choose a JPG, PNG or WebP picture for your photo.');
    expect(pictureFileProblem({ type: 'image/gif', size: 10 }, 'logo', 'the logo')).toBe('Choose a JPG, PNG or WebP picture for the logo.');
  });

  it('the editor builds every sentence from `subject` (default "your {name}"), and the entity passes "the logo" / "the banner"', () => {
    const editor = read('components/picture/PictureEditor.tsx');
    expect(editor).toMatch(/const named = subject \?\? `your \$\{name\}`;/);
    expect(editor).toMatch(/errorMessage\(err, `Could not save \$\{named\} right now\. Try again in a moment\.`\)/);
    expect(editor).toMatch(/pictureFileProblem\(file, name, named\)/);
    expect(editor).not.toMatch(/your \$\{name\}`\)|for your \$\{name\}/);
    expect(read('features/reason/entities/useEntityPicture.ts')).toMatch(/subject: `the \$\{kind\}`,/);
  });
});
