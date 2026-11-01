// ─── The crop of a profile picture (30 Oct review, T3a) ──────────────────────
// One piece of arithmetic, in shared/, used by the server to cut the picture and by the editor in the browser to show
// it: a crop is where the middle of the kept part sits (as a share of the picture's width and height) and how far in
// it is zoomed (1 = the largest part of the picture's shape that fits). Whatever a page sends, the kept part is
// inside the picture and has exactly the shape asked for.

import {
  PICTURE_CENTRED, PICTURE_MAX_ZOOM, PICTURE_SHAPES, clampPictureCrop, pictureCropRect, pictureOutputSize,
} from '@rsn/shared';

describe('the picture shapes (L1)', () => {
  it('a photo is a 1024 square JPEG at 0.9, a banner 2400 by 800 at 0.85', () => {
    expect(PICTURE_SHAPES.avatar).toEqual({ aspect: 1, width: 1024, height: 1024, quality: 0.9 });
    expect(PICTURE_SHAPES.banner).toEqual({ aspect: 3, width: 2400, height: 800, quality: 0.85 });
  });

  it('zooms from 1 to 4, and a new picture starts centred and not zoomed', () => {
    expect(PICTURE_MAX_ZOOM).toBe(4);
    expect(PICTURE_CENTRED).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
  });
});

describe('pictureCropRect', () => {
  it('not zoomed and centred, a photo keeps the largest centred square', () => {
    expect(pictureCropRect(PICTURE_CENTRED, 4000, 3000, 1)).toEqual({ left: 500, top: 0, width: 3000, height: 3000 });
    expect(pictureCropRect(PICTURE_CENTRED, 3000, 4000, 1)).toEqual({ left: 0, top: 500, width: 3000, height: 3000 });
  });

  it('not zoomed and centred, a banner keeps the widest centred 3:1 strip', () => {
    expect(pictureCropRect(PICTURE_CENTRED, 3000, 3000, 3)).toEqual({ left: 0, top: 1000, width: 3000, height: 1000 });
    expect(pictureCropRect(PICTURE_CENTRED, 6000, 1000, 3)).toEqual({ left: 1500, top: 0, width: 3000, height: 1000 });
  });

  it('zoom 2 keeps half the side, around the chosen middle', () => {
    expect(pictureCropRect({ x: 0.5, y: 0.25, zoom: 2 }, 2000, 2000, 1)).toEqual({ left: 500, top: 0, width: 1000, height: 1000 });
    expect(pictureCropRect({ x: 0.75, y: 0.75, zoom: 2 }, 2000, 2000, 1)).toEqual({ left: 1000, top: 1000, width: 1000, height: 1000 });
  });

  it('a middle too near an edge is moved in, so the kept part never leaves the picture', () => {
    expect(pictureCropRect({ x: 0, y: 1, zoom: 2 }, 2000, 2000, 1)).toEqual({ left: 0, top: 1000, width: 1000, height: 1000 });
    expect(pictureCropRect({ x: 1, y: 0, zoom: 1 }, 4000, 3000, 1)).toEqual({ left: 1000, top: 0, width: 3000, height: 3000 });
  });
});

describe('clampPictureCrop', () => {
  it('holds the zoom between 1 and 4', () => {
    expect(clampPictureCrop({ x: 0.5, y: 0.5, zoom: 0.2 }, 1000, 1000, 1).zoom).toBe(1);
    expect(clampPictureCrop({ x: 0.5, y: 0.5, zoom: 9 }, 1000, 1000, 1).zoom).toBe(4);
  });

  it('moves the middle in from the edges by half the kept part', () => {
    expect(clampPictureCrop({ x: 0, y: 0, zoom: 2 }, 1000, 1000, 1)).toEqual({ x: 0.25, y: 0.25, zoom: 2 });
    expect(clampPictureCrop({ x: 1, y: 1, zoom: 4 }, 1000, 1000, 1)).toEqual({ x: 0.875, y: 0.875, zoom: 4 });
  });

  it('on a side the kept part fills, the middle is the middle', () => {
    expect(clampPictureCrop({ x: 0.1, y: 0.9, zoom: 1 }, 4000, 3000, 1)).toEqual({ x: 0.125 * 3, y: 0.5, zoom: 1 });
  });

  it('reads anything that is not a number as the centred crop', () => {
    expect(clampPictureCrop({ x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: Number.NaN }, 1000, 1000, 1))
      .toEqual(PICTURE_CENTRED);
  });
});

describe('pictureOutputSize', () => {
  it('a part as big as the shape or bigger is drawn at the shape\'s size', () => {
    expect(pictureOutputSize({ left: 0, top: 0, width: 3000, height: 3000 }, PICTURE_SHAPES.avatar)).toEqual({ width: 1024, height: 1024 });
    expect(pictureOutputSize({ left: 0, top: 0, width: 3000, height: 1000 }, PICTURE_SHAPES.banner)).toEqual({ width: 2400, height: 800 });
  });

  it('a smaller part is never enlarged: it is drawn at its own size', () => {
    expect(pictureOutputSize({ left: 0, top: 0, width: 300, height: 300 }, PICTURE_SHAPES.avatar)).toEqual({ width: 300, height: 300 });
    expect(pictureOutputSize({ left: 0, top: 0, width: 1500, height: 500 }, PICTURE_SHAPES.banner)).toEqual({ width: 1500, height: 500 });
  });
});
