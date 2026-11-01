// client/src/components/picture/picture-file.ts
// The rules for a picture a member chooses (30 Oct review, T3a). The server keeps the picture as it came, so it is
// sent as it is whenever the server would keep it as it is (a JPEG, PNG or WebP of at most 3 MB and 4096 pixels a
// side); a bigger one (a 48 MP phone photo) is first copied smaller in the browser (prepare-picture.ts).
// Pure on purpose (no React or DOM), so a test can run it: server/src/__tests__/client/picture-editor.test.ts.
import type { Natural } from './picture-geometry';

export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** The largest file opened in the browser. It is copied smaller before it is sent, but a huge one is slow on a phone. */
export const PICTURE_INPUT_MAX_BYTES = 20 * 1024 * 1024;
/** What the server keeps as it is (server/src/services/user/picture-file.ts). */
export const PICTURE_SEND_MAX_BYTES = 3 * 1024 * 1024;
export const PICTURE_SEND_MAX_SIDE = 4096;

/** Why a chosen file cannot be opened, in a sentence, or null when it can. `name` is what it is for: photo, banner, logo. */
export function pictureFileProblem(file: { type: string; size: number }, name: string): string | null {
  if (!(PICTURE_TYPES as readonly string[]).includes(file.type)) return `Choose a JPG, PNG or WebP picture for your ${name}.`;
  if (file.size > PICTURE_INPUT_MAX_BYTES) return 'Choose a picture under 20 MB.';
  return null;
}

/** True when the file can go to the server exactly as it is. */
export function sendsAsItIs(file: { type: string; size: number }, natural: Natural): boolean {
  return (PICTURE_TYPES as readonly string[]).includes(file.type)
    && file.size <= PICTURE_SEND_MAX_BYTES
    && natural.width <= PICTURE_SEND_MAX_SIDE
    && natural.height <= PICTURE_SEND_MAX_SIDE;
}
