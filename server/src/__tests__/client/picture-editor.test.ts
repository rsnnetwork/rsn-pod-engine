// ─── The picture editor: drag, zoom, pinch and keys (30 Oct review, T3a) ─────────────────────────────────────────
// "Add an edit (pencil) button directly on the profile picture. Edit button that allows to fix the size or position."
// The arithmetic of the editor is pure (client/src/components/picture/picture-geometry.ts), so it is run here; the
// components are read as source for the parts a test can only check by reading (44px controls, the portal, the
// words). The server cuts the kept picture with the same crop (shared/src/picture/crop.ts).

import * as fs from 'fs';
import * as path from 'path';
import { PICTURE_MAX_ZOOM, pictureCropRect } from '@rsn/shared';
import {
  NUDGE, ZOOM_STEP, keyedCrop, panPicture, pictureView, pinchZoom, zoomPicture,
} from '../../../../client/src/components/picture/picture-geometry';
import {
  PICTURE_INPUT_MAX_BYTES, PICTURE_SEND_MAX_BYTES, PICTURE_SEND_MAX_SIDE, pictureFileProblem, sendsAsItIs,
} from '../../../../client/src/components/picture/picture-file';
import { isSmallPhoto } from '../../../../client/src/features/reason/human/profile-text';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const lines = (rel: string) => read(rel).split('\n').length;

const PHOTO = { width: 3000, height: 2000 };

describe('pictureView: where the picture sits in the frame', () => {
  it('not zoomed, a 3000 by 2000 photo in a 300px square frame fills its height and shows its middle', () => {
    const view = pictureView({ x: 0.5, y: 0.5, zoom: 1 }, PHOTO, 300, 1);
    expect(view).toEqual({ left: -75, top: 0, width: 450, height: 300 });
  });

  it('zoomed in 2, it is twice as big and still centred on the chosen middle', () => {
    const view = pictureView({ x: 0.5, y: 0.5, zoom: 2 }, PHOTO, 300, 1);
    expect(view).toEqual({ left: -300, top: -150, width: 900, height: 600 });
  });

  it('shows exactly the part the server keeps', () => {
    const crop = { x: 0.3, y: 0.6, zoom: 1.7 };
    const view = pictureView(crop, PHOTO, 300, 1);
    const kept = pictureCropRect(crop, PHOTO.width, PHOTO.height, 1);
    const scale = 300 / kept.width;
    expect(view.left).toBeCloseTo(-kept.left * scale, 6);
    expect(view.top).toBeCloseTo(-kept.top * scale, 6);
  });
});

describe('dragging and zooming', () => {
  it('dragging the picture right shows more of its left side', () => {
    const moved = panPicture({ x: 0.5, y: 0.5, zoom: 1 }, 30, 0, PHOTO, 300, 1);
    // 300px of frame show 2000 source pixels, so 30px are 200 source pixels: a fifteenth of the width.
    expect(moved.x).toBeCloseTo(0.5 - 200 / 3000, 6);
    expect(moved.y).toBe(0.5);
  });

  it('a drag can never take the picture out of the frame', () => {
    expect(panPicture({ x: 0.5, y: 0.5, zoom: 1 }, 5000, 5000, PHOTO, 300, 1)).toEqual({ x: 1 / 3, y: 0.5, zoom: 1 });
  });

  it('zoom is held from 1 to 4, and the middle moves in to keep the frame full', () => {
    expect(zoomPicture({ x: 0.5, y: 0.5, zoom: 1 }, 9, PHOTO, 1).zoom).toBe(PICTURE_MAX_ZOOM);
    expect(zoomPicture({ x: 0.5, y: 0.5, zoom: 2 }, 0.2, PHOTO, 1).zoom).toBe(1);
    expect(zoomPicture({ x: 0.9, y: 0.5, zoom: 2 }, 1, PHOTO, 1).x).toBeCloseTo(2 / 3, 6);
  });

  it('a pinch zooms by how far the fingers spread', () => {
    expect(pinchZoom(1, 100, 200)).toBe(2);
    expect(pinchZoom(2, 200, 100)).toBe(1);
    expect(pinchZoom(1.5, 0, 100)).toBe(1.5);
  });
});

describe('the keyboard', () => {
  const at = { x: 0.5, y: 0.5, zoom: 2 };
  it('arrows move the picture a little, and further with Shift', () => {
    expect(keyedCrop(at, 'ArrowRight', false, PHOTO, 1)!.x).toBeCloseTo(0.5 - NUDGE * (1000 / 3000), 6);
    expect(keyedCrop(at, 'ArrowDown', false, PHOTO, 1)!.y).toBeCloseTo(0.5 - NUDGE * (1000 / 2000), 6);
    expect(keyedCrop(at, 'ArrowLeft', true, PHOTO, 1)!.x).toBeCloseTo(0.5 + 5 * NUDGE * (1000 / 3000), 6);
  });

  it('+ and - zoom by a step', () => {
    expect(keyedCrop(at, '+', false, PHOTO, 1)!.zoom).toBeCloseTo(2 + ZOOM_STEP, 6);
    expect(keyedCrop(at, '=', false, PHOTO, 1)!.zoom).toBeCloseTo(2 + ZOOM_STEP, 6);
    expect(keyedCrop(at, '-', false, PHOTO, 1)!.zoom).toBeCloseTo(2 - ZOOM_STEP, 6);
  });

  it('any other key is left to the page', () => {
    expect(keyedCrop(at, 'Tab', false, PHOTO, 1)).toBeNull();
    expect(keyedCrop(at, 'Enter', false, PHOTO, 1)).toBeNull();
  });
});

describe('the picture a member chooses', () => {
  it('a JPG, PNG or WebP of up to 20 MB can be opened; anything else is said in a sentence', () => {
    expect(PICTURE_INPUT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(pictureFileProblem({ type: 'image/webp', size: 5_000_000 }, 'photo')).toBeNull();
    expect(pictureFileProblem({ type: 'image/gif', size: 10 }, 'photo')).toBe('Choose a JPG, PNG or WebP picture for your photo.');
    expect(pictureFileProblem({ type: '', size: 10 }, 'banner')).toBe('Choose a JPG, PNG or WebP picture for your banner.');
    expect(pictureFileProblem({ type: 'image/png', size: PICTURE_INPUT_MAX_BYTES + 1 }, 'photo')).toBe('Choose a picture under 20 MB.');
  });

  it('is sent as it is when the server keeps it as it is (3 MB, 4096 a side); otherwise a smaller copy is made first', () => {
    expect(PICTURE_SEND_MAX_BYTES).toBe(3 * 1024 * 1024);
    expect(PICTURE_SEND_MAX_SIDE).toBe(4096);
    expect(sendsAsItIs({ type: 'image/jpeg', size: 2_000_000 }, { width: 4032, height: 3024 })).toBe(true);
    expect(sendsAsItIs({ type: 'image/jpeg', size: 3_200_000 }, { width: 4032, height: 3024 })).toBe(false);
    expect(sendsAsItIs({ type: 'image/png', size: 900_000 }, { width: 8000, height: 6000 })).toBe(false);
  });
});

describe('no upscaling on the profile (D7): a photo under 400 pixels is drawn at its own size', () => {
  it('measures the smaller side', () => {
    expect(isSmallPhoto(96, 96)).toBe(true);
    expect(isSmallPhoto(200, 200)).toBe(true);
    expect(isSmallPhoto(1024, 399)).toBe(true);
    expect(isSmallPhoto(400, 400)).toBe(false);
    expect(isSmallPhoto(512, 512)).toBe(false);
    expect(isSmallPhoto(0, 0)).toBe(false);
  });

  it('the hero fills the tile with a large photo, and centres a small one at its own size', () => {
    const hero = read('features/reason/human/ProfileHero.tsx');
    expect(hero).toMatch(/isSmallPhoto\(img\.naturalWidth, img\.naturalHeight\)/);
    expect(hero).toMatch(/\[&>img\]:h-auto \[&>img\]:w-auto \[&>img\]:max-w-full/);
  });
});

describe('the editor and the pencil, as built', () => {
  it('the pencil is a 44px round button named for what it edits', () => {
    const pencil = read('components/picture/PencilButton.tsx');
    expect(pencil).toMatch(/h-11 w-11/);
    expect(pencil).toMatch(/aria-label=\{label\}/);
    expect(read('features/reason/profile/YourProfilePage.tsx')).toMatch(/<PencilButton label="Edit photo"/);
    expect(read('features/reason/profile/BannerEditor.tsx')).toMatch(/<PencilButton label="Edit banner"/);
    expect(read('features/profile/ProfilePage.tsx')).toMatch(/<PencilButton label="Edit photo"/);
  });

  it('the editor is a sheet (portalled to the page body) with Cancel and Save, a zoom slider and a way to choose another picture', () => {
    const editor = read('components/picture/PictureEditor.tsx');
    expect(editor).toMatch(/<Sheet\b/);
    expect(read('features/reason/ui/Sheet.tsx')).toMatch(/createPortal\([\s\S]*document\.body/);
    expect(editor).toMatch(/>\s*Cancel\s*</);
    expect(editor).toMatch(/busy \? 'Saving\.\.\.' : 'Save'/);
    expect(editor).toMatch(/Choose another picture/);
    expect(read('components/picture/ZoomControl.tsx')).toMatch(/type="range"/);
  });

  it('the frame takes a drag without scrolling the page, and answers the keyboard', () => {
    const frame = read('components/picture/PictureFrame.tsx');
    expect(frame).toMatch(/touch-none/);
    expect(frame).toMatch(/onPointerDown/);
    expect(frame).toMatch(/onKeyDown/);
    expect(frame).toMatch(/tabIndex=\{0\}/);
  });

  it('every component is at most 200 lines', () => {
    for (const file of ['PictureEditor.tsx', 'PictureFrame.tsx', 'PencilButton.tsx', 'ZoomControl.tsx']) {
      expect({ file, lines: lines(`components/picture/${file}`) <= 200 }).toEqual({ file, lines: true });
    }
  });

  it('every place a member edits their photo opens the same editor: their profile, the form and onboarding screen 7', () => {
    for (const file of ['features/reason/profile/YourProfilePage.tsx', 'features/profile/ProfilePage.tsx', 'features/onboarding/PhotoField.tsx', 'features/reason/profile/BannerEditor.tsx']) {
      expect({ file, editor: /<PictureEditor\b/.test(read(file)) }).toEqual({ file, editor: true });
    }
  });

  it('the kept picture is asked for only while the editor is open, and follows the member\'s own tag', () => {
    const hook = read('components/picture/useMemberPicture.ts');
    expect(hook).toMatch(/enabled: open && !chosen && !!me/);
    expect(hook).toMatch(/meta: \{ entities: me \? \[E\.user\(me\)\] : \[\] \}/);
    expect(hook).toMatch(/checkSession\(\)/);
    expect(hook).toMatch(/invalidateQueries\(\{ queryKey: reasonKeys\.mine \}\)/);
  });
});
