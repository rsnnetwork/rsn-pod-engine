// client/src/features/reason/profile/banner-image.ts
// The banner picture, made in the browser before it is sent (21 Oct 2026): the widest 3:1 strip from the middle
// of the chosen picture, drawn at 1500 by 500 and sent as a JPEG. The server takes at most 3 MB; a 1500x500 JPEG
// is a few hundred KB, so the picture a member picks can be much bigger than that.
// The rules are pure on purpose (no React, axios, store, router or DOM), so a test can run them:
// server/src/__tests__/client/reason-your-profile.test.ts. The drawing itself is in crop-banner.ts.

export const BANNER_WIDTH = 1500;
export const BANNER_HEIGHT = 500;
export const BANNER_QUALITY = 0.85;
export const BANNER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** The largest picture opened in the browser. It is never sent as it is, but a huge one is slow to open on a phone. */
export const BANNER_INPUT_MAX_BYTES = 20 * 1024 * 1024;

export interface Crop { sx: number; sy: number; sw: number; sh: number }

/** The part of a width x height picture that becomes the banner: the widest centred strip of the banner's shape. */
export function bannerCrop(width: number, height: number): Crop {
  const ratio = BANNER_WIDTH / BANNER_HEIGHT;
  if (width / height > ratio) {
    const sw = height * ratio;
    return { sx: (width - sw) / 2, sy: 0, sw, sh: height };
  }
  const sh = width / ratio;
  return { sx: 0, sy: (height - sh) / 2, sw: width, sh };
}

/** Why a chosen file cannot be a banner, in a sentence, or null when it can be opened. */
export function bannerFileProblem(file: { type: string; size: number }): string | null {
  if (!(BANNER_TYPES as readonly string[]).includes(file.type)) return 'Choose a JPG, PNG or WebP picture for your banner.';
  if (file.size > BANNER_INPUT_MAX_BYTES) return 'Choose a picture under 20 MB.';
  return null;
}
