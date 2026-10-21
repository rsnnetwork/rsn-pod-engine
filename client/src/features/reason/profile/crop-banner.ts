// client/src/features/reason/profile/crop-banner.ts
// The banner picture drawn in the browser: the strip bannerCrop chooses, at 1500 by 500, as a JPEG data URL.
// It needs a canvas, so it is apart from the rules in banner-image.ts, which a test runs without a browser.
import { BANNER_HEIGHT, BANNER_QUALITY, BANNER_WIDTH, bannerCrop } from './banner-image';

/** What the page says when the browser cannot open the chosen file as a picture. */
export const UNREADABLE_PICTURE = 'We could not read that picture. Please choose another one.';

function openPicture(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(UNREADABLE_PICTURE)); };
    img.src = url;
  });
}

/** The chosen picture as the banner: a 1500x500 JPEG data URL cut from its middle. */
export async function cropToBanner(file: File): Promise<string> {
  const img = await openPicture(file);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error(UNREADABLE_PICTURE);
  const { sx, sy, sw, sh } = bannerCrop(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = BANNER_WIDTH;
  canvas.height = BANNER_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(UNREADABLE_PICTURE);
  // A JPEG has no transparency: a see-through PNG would turn black without a white ground under it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, BANNER_WIDTH, BANNER_HEIGHT);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, BANNER_WIDTH, BANNER_HEIGHT);
  return canvas.toDataURL('image/jpeg', BANNER_QUALITY);
}
