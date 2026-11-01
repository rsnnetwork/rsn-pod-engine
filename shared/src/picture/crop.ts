// ─── The crop of a profile picture (30 Oct review, T3a) ──────────────────────
//
// "Add an edit (pencil) button directly on the profile picture. Edit button that allows to fix the size or position."
// The member's own picture is kept as they chose it, with a crop beside it, and the picture everyone sees is cut
// from it on the server. The same arithmetic shows the picture in the editor, so what the member places in the frame
// is exactly what is kept.
//
// A crop is where the middle of the kept part sits, as a share (0 to 1) of the picture's width and of its height,
// and how far in it is zoomed: 1 is the largest part of the picture's shape that fits, 2 is half as wide. Shares,
// not pixels, so a crop still means the same thing on a smaller copy of the same picture.

export type PictureKind = 'avatar' | 'banner';

export interface PictureCrop {
  /** The middle of the kept part, as a share of the picture's width. */
  x: number;
  /** The middle of the kept part, as a share of the picture's height. */
  y: number;
  /** 1 = the largest part of the shape that fits; up to PICTURE_MAX_ZOOM. */
  zoom: number;
}

/** A part of a picture, in its pixels. */
export interface PictureRect { left: number; top: number; width: number; height: number }

export interface PictureShape {
  /** Width over height. */
  aspect: number;
  /** The size it is kept at, at most (L1). */
  width: number;
  height: number;
  /** The JPEG quality it is kept at, 0 to 1. */
  quality: number;
}

/** L1: a photo is kept as a 1024 square JPEG at 0.9, a banner as 2400 by 800 at 0.85. */
export const PICTURE_SHAPES: Record<PictureKind, PictureShape> = {
  avatar: { aspect: 1, width: 1024, height: 1024, quality: 0.9 },
  banner: { aspect: 3, width: 2400, height: 800, quality: 0.85 },
};

export const PICTURE_MAX_ZOOM = 4;

/** A picture nobody has placed yet: its middle, not zoomed. */
export const PICTURE_CENTRED: PictureCrop = { x: 0.5, y: 0.5, zoom: 1 };

/** What the member's editor opens on: the picture they chose (or the one they have) and where they placed it. */
export interface PictureSource {
  /** The picture as a data URL, or null when there is none to place. */
  image: string | null;
  /** Where it was placed, or null when it has never been placed (it opens centred). */
  crop: PictureCrop | null;
}

const within = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const numberOr = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

/** The kept part's size before it is placed: the largest of the shape that fits, divided by the zoom. */
function keptSize(zoom: number, width: number, height: number, aspect: number): { width: number; height: number } {
  if (width / height > aspect) {
    const h = Math.max(1, Math.min(height, Math.round(height / zoom)));
    return { width: Math.max(1, Math.min(width, Math.round(h * aspect))), height: h };
  }
  const w = Math.max(1, Math.min(width, Math.round(width / zoom)));
  return { width: w, height: Math.max(1, Math.min(height, Math.round(w / aspect))) };
}

/** The crop moved and zoomed only as far as it can go: the zoom from 1 to 4, the kept part inside the picture. */
export function clampPictureCrop(crop: PictureCrop, width: number, height: number, aspect: number): PictureCrop {
  const zoom = within(numberOr(crop.zoom, 1), 1, PICTURE_MAX_ZOOM);
  const kept = keptSize(zoom, width, height, aspect);
  const halfX = kept.width / 2 / width;
  const halfY = kept.height / 2 / height;
  return {
    x: within(numberOr(crop.x, 0.5), halfX, 1 - halfX),
    y: within(numberOr(crop.y, 0.5), halfY, 1 - halfY),
    zoom,
  };
}

/** The part of a width x height picture a crop keeps, in whole pixels, always inside the picture. */
export function pictureCropRect(crop: PictureCrop, width: number, height: number, aspect: number): PictureRect {
  const placed = clampPictureCrop(crop, width, height, aspect);
  const kept = keptSize(placed.zoom, width, height, aspect);
  return {
    left: within(Math.round(placed.x * width - kept.width / 2), 0, width - kept.width),
    top: within(Math.round(placed.y * height - kept.height / 2), 0, height - kept.height),
    width: kept.width,
    height: kept.height,
  };
}

/** The size a kept part is drawn at: the shape's size, or the part's own when it is smaller (never enlarged). */
export function pictureOutputSize(rect: PictureRect, shape: PictureShape): { width: number; height: number } {
  const width = Math.max(1, Math.min(shape.width, rect.width));
  return { width, height: Math.max(1, Math.round(width / shape.aspect)) };
}
