// client/src/components/picture/send-picture.ts
// The one save step for every picture (T15 review I1): the member's photo and banner (useMemberPicture) and an
// entity's logo and banner (useEntityPicture). Pure on purpose (the browser's part is handed in as `prepare`, which is
// prepare-picture.ts's pictureToSend), so a test can run it: server/src/__tests__/client/picture-send.test.ts.
import type { PictureCrop } from '@rsn/shared';
import { serverCouldNotOpen } from './picture-file';

/** What a picture save sends: a new picture (a data URL) with where it was placed, or only the new place. */
export interface PictureSend { image?: string; crop: PictureCrop }

/** Makes a chosen file ready to send: as it is (or a smaller copy), or with `drawCopy` a copy the browser draws. */
export type PreparePicture = (file: Blob, drawCopy?: boolean) => Promise<{ image: string; copied: boolean }>;

/**
 * The picture they had (no file) sends only its crop. A new file is sent as `prepare` makes it; when the server
 * answers that it cannot open the original, a copy the browser draws (it is in the frame) is sent once more, and
 * never a copy of a copy. Any other refusal is passed on as it came.
 */
export async function sendPicture<T>(
  picture: Blob | null, crop: PictureCrop, send: (body: PictureSend) => Promise<T>, prepare: PreparePicture,
): Promise<T> {
  if (!picture) return send({ crop });
  const first = await prepare(picture);
  try {
    return await send({ image: first.image, crop });
  } catch (err) {
    if (first.copied || !serverCouldNotOpen(err)) throw err;
    const copy = await prepare(picture, true);
    return send({ image: copy.image, crop });
  }
}
