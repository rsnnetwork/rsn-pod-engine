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
export function pictureFileProblem(file: { type: string; size: number }, name: string, named = `your ${name}`): string | null {
  if (!(PICTURE_TYPES as readonly string[]).includes(file.type)) return `Choose a JPG, PNG or WebP picture for ${named}.`;
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

/** What the server says when it cannot open a picture's bytes (server/src/services/user/picture-file.ts). */
const COULD_NOT_OPEN = 'That file is not a picture we can use. Choose a JPG, PNG or WebP picture.';

/**
 * True when the server refused a picture because it could not open it. A browser forgives files a decoder does not
 * (a PNG with a bad checksum draws in Chrome and Safari but stops libspng), so the caller then sends a copy drawn by
 * the browser, which already shows the picture in the editor's frame.
 */
export function serverCouldNotOpen(err: unknown): boolean {
  const failed = (err ?? {}) as { response?: { status?: number; data?: { error?: { message?: unknown } } } };
  return failed.response?.status === 400 && failed.response.data?.error?.message === COULD_NOT_OPEN;
}

/**
 * What the banner editor says under the picture (Shirley pilot S6, RSN 13): the size the server keeps a banner at
 * (PICTURE_SHAPES.banner, 2400 by 800), and that a wide screen shows only its middle band. Every profile draws its banner
 * in one box (ProfileBanner: 3:1, at most 260px tall), so on a page wider than 780px the top and bottom are cropped.
 */
export function bannerHints(width: number, height: number): { size: string; crop: string } {
  return {
    size: `Recommended size: ${width} × ${height} px (3:1).`,
    crop: 'Wide screens crop the top and bottom of your banner, so keep faces and words near the middle.',
  };
}
