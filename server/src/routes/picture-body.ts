// ─── What a picture route accepts (30 Oct review: T3a for the member's photo and banner, T15 for an entity's) ─────
//
// A new picture is a data URL; the service checks the type, the bytes and the decoded size (picture-file.ts). This
// cap is only the longest text that can hold the largest picture allowed. A crop alone places the kept picture again.
// The crop is the middle of the kept part as shares of the picture's width and height, and the zoom; the server
// holds the part inside the picture whatever it is sent, and these bounds only refuse what no editor sends.

import { z } from 'zod';
import { PICTURE_MAX_ZOOM } from '@rsn/shared';
import { PICTURE_MAX_DATA_URL_CHARS } from '../services/user/picture-file';

export const pictureCropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  zoom: z.number().min(1).max(PICTURE_MAX_ZOOM),
}).strict();

/** `{ image?, crop? }`, one of them at least, refused in the words given. */
export const pictureBodySchema = (words: { choose: string; tooBig: string }) => z.object({
  image: z.string().min(1, words.choose).max(PICTURE_MAX_DATA_URL_CHARS, words.tooBig).optional(),
  crop: pictureCropSchema.optional(),
}).refine((b) => b.image !== undefined || b.crop !== undefined, { message: words.choose, path: ['image'] });

export type PictureBody = z.infer<ReturnType<typeof pictureBodySchema>>;
