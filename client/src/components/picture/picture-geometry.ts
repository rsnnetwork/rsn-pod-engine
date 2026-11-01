// client/src/components/picture/picture-geometry.ts
// The picture editor's arithmetic (30 Oct review, T3a): where the picture sits in the frame for a crop, and how a drag,
// the zoom, a pinch or a key changes the crop. The crop itself, and the part of the picture it keeps, are the server's
// own (shared/src/picture/crop.ts), so the frame shows exactly what will be kept.
// Pure on purpose (no React or DOM), so a test can run it: server/src/__tests__/client/picture-editor.test.ts.
import { clampPictureCrop, pictureCropRect, type PictureCrop } from '@rsn/shared';

export interface Natural { width: number; height: number }

/** Where the picture is drawn in the frame, in CSS pixels from the frame's top left. */
export interface PictureView { left: number; top: number; width: number; height: number }

/** How far an arrow key moves the picture: a share of the part shown (five times that with Shift). */
export const NUDGE = 0.02;
/** How far + and - zoom. */
export const ZOOM_STEP = 0.1;

/** The picture's place in a frame `frameWidth` wide: the kept part fills the frame exactly. */
export function pictureView(crop: PictureCrop, natural: Natural, frameWidth: number, aspect: number): PictureView {
  const kept = pictureCropRect(crop, natural.width, natural.height, aspect);
  const scale = frameWidth / kept.width;
  return { left: 0 - kept.left * scale, top: 0 - kept.top * scale, width: natural.width * scale, height: natural.height * scale };
}

/** The crop after the picture is dragged by dx, dy CSS pixels: the picture follows the finger. */
export function panPicture(crop: PictureCrop, dx: number, dy: number, natural: Natural, frameWidth: number, aspect: number): PictureCrop {
  const kept = pictureCropRect(crop, natural.width, natural.height, aspect);
  const scale = frameWidth / kept.width;
  const moved = { ...crop, x: crop.x - dx / (scale * natural.width), y: crop.y - dy / (scale * natural.height) };
  return clampPictureCrop(moved, natural.width, natural.height, aspect);
}

/** The crop at another zoom, held from 1 to 4, its middle moved in when the frame would show past the picture. */
export function zoomPicture(crop: PictureCrop, zoom: number, natural: Natural, aspect: number): PictureCrop {
  return clampPictureCrop({ ...crop, zoom }, natural.width, natural.height, aspect);
}

/** The zoom a pinch asks for: the zoom it started at, times how far the fingers have spread. */
export function pinchZoom(startZoom: number, startDistance: number, distance: number): number {
  return startDistance > 0 ? (startZoom * distance) / startDistance : startZoom;
}

/** The crop after a key: arrows move the picture the way they point, + and - zoom. Null for any other key. */
export function keyedCrop(crop: PictureCrop, key: string, shift: boolean, natural: Natural, aspect: number): PictureCrop | null {
  const kept = pictureCropRect(crop, natural.width, natural.height, aspect);
  const step = NUDGE * (shift ? 5 : 1);
  const shareX = (kept.width / natural.width) * step;
  const shareY = (kept.height / natural.height) * step;
  const next = (c: PictureCrop) => clampPictureCrop(c, natural.width, natural.height, aspect);
  switch (key) {
    case 'ArrowRight': return next({ ...crop, x: crop.x - shareX });
    case 'ArrowLeft': return next({ ...crop, x: crop.x + shareX });
    case 'ArrowDown': return next({ ...crop, y: crop.y - shareY });
    case 'ArrowUp': return next({ ...crop, y: crop.y + shareY });
    case '+':
    case '=': return next({ ...crop, zoom: crop.zoom + ZOOM_STEP });
    case '-':
    case '_': return next({ ...crop, zoom: crop.zoom - ZOOM_STEP });
    default: return null;
  }
}
