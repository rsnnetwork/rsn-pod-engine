// ─── The member's photo and banner, cut on the server from the picture they chose (30 Oct review, T3a) ──────────
//
// "Add an edit (pencil) button directly on the profile picture ... that allows to fix the size or position", and
// "Pictures look pixelated". The picture the member chooses is kept with where they placed it; the one everyone sees
// is cut from it here, at L1's sizes (a 1024 square JPEG at 0.9, a 2400 by 800 JPEG at 0.85), never enlarged.
// Placing it again later needs only the new crop. These run the real decoder (sharp) on real pictures, against a
// stand-in for the database.

jest.mock('../../../config', () => ({
  default: { apiBaseUrl: 'https://api.example.test', jwtSecret: 'x', env: 'test', isTest: true },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

import { getPictureSource, renderPicture, savePicture } from '../../../services/user/picture.service';
import { fakeUserRow } from '../../fixtures/fake-user-row';
import { BLUE, RED, WHITE, clear, colourAt, halves, near, sizeOf, solid } from '../../fixtures/real-pictures';
import { dataUrl, jpeg } from '../../fixtures/pictures';

const ME = '6f1c2d3e-4a5b-4c6d-8e7f-901234567890';
let db = fakeUserRow({ id: ME });
beforeEach(() => {
  db = fakeUserRow({ id: ME });
  mockQuery.mockReset().mockImplementation((sql: string, params?: unknown[]) => Promise.resolve(db.handle(sql, params) ?? { rows: [] }));
});

describe('renderPicture', () => {
  it('a photo is a 1024 square JPEG, cut from the middle when nobody placed it', async () => {
    const out = await renderPicture(await solid(2000, 1500), 'avatar', { x: 0.5, y: 0.5, zoom: 1 });
    expect(out.mime).toBe('image/jpeg');
    expect(await sizeOf(out.bytes)).toEqual({ width: 1024, height: 1024, format: 'jpeg' });
  });

  it('a banner is a 2400 by 800 JPEG', async () => {
    const out = await renderPicture(await solid(3000, 3000, BLUE, 'png'), 'banner', { x: 0.5, y: 0.5, zoom: 1 });
    expect(await sizeOf(out.bytes)).toEqual({ width: 2400, height: 800, format: 'jpeg' });
  });

  it('keeps the part the member placed in the frame', async () => {
    const picture = await halves(2000, 1000, RED, BLUE);
    const left = await renderPicture(picture, 'avatar', { x: 0.25, y: 0.5, zoom: 1 });
    const right = await renderPicture(picture, 'avatar', { x: 0.75, y: 0.5, zoom: 1 });
    expect(near(await colourAt(left.bytes, 512, 512), RED)).toBe(true);
    expect(near(await colourAt(right.bytes, 512, 512), BLUE)).toBe(true);
  });

  it('a phone photo stored on its side is cut as the phone shows it (EXIF orientation)', async () => {
    // Stored 2000 wide by 1000 high, red on the left; orientation 6 turns it a quarter clockwise, so it shows
    // 1000 wide by 2000 high with the red on top, the way a browser draws it in the editor.
    const picture = await halves(2000, 1000, RED, BLUE, { orientation: 6 });
    const top = await renderPicture(picture, 'avatar', { x: 0.5, y: 0.25, zoom: 1 });
    const bottom = await renderPicture(picture, 'avatar', { x: 0.5, y: 0.75, zoom: 1 });
    expect(await sizeOf(top.bytes)).toEqual({ width: 1000, height: 1000, format: 'jpeg' });
    expect(near(await colourAt(top.bytes, 500, 500), RED)).toBe(true);
    expect(near(await colourAt(bottom.bytes, 500, 500), BLUE)).toBe(true);
  });

  it('never enlarges: a small picture is kept at its own size', async () => {
    expect(await sizeOf((await renderPicture(await solid(300, 400), 'avatar', { x: 0.5, y: 0.5, zoom: 1 })).bytes))
      .toEqual({ width: 300, height: 300, format: 'jpeg' });
    expect(await sizeOf((await renderPicture(await solid(1500, 500), 'banner', { x: 0.5, y: 0.5, zoom: 1 })).bytes))
      .toEqual({ width: 1500, height: 500, format: 'jpeg' });
  });

  it('a see-through PNG is put on white, not black', async () => {
    const out = await renderPicture(await clear(600, 600), 'avatar', { x: 0.5, y: 0.5, zoom: 1 });
    expect(near(await colourAt(out.bytes, 300, 300), WHITE)).toBe(true);
  });

  it('answers with the crop as it was used: moved in from the edge, the zoom held to 1..4', async () => {
    const out = await renderPicture(await solid(1000, 1000), 'avatar', { x: 0, y: 1, zoom: 2 });
    expect(out.crop).toEqual({ x: 0.25, y: 0.75, zoom: 2 });
  });

  it('a file that only looks like a picture is refused in a sentence, as a 400', async () => {
    await expect(renderPicture(jpeg(800, 800, 4000), 'avatar', { x: 0.5, y: 0.5, zoom: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(renderPicture(jpeg(800, 800, 4000), 'avatar', { x: 0.5, y: 0.5, zoom: 1 }))
      .rejects.toThrow('That file is not a picture we can use. Choose a JPG, PNG or WebP picture.');
  });
});

describe('savePicture (a new picture)', () => {
  it('keeps the chosen photo as it came and its crop, and the 1024 photo everyone sees, at a new address', async () => {
    const chosen = await halves(2000, 1500, RED, BLUE);
    const out = await savePicture('avatar', ME, { image: dataUrl('image/jpeg', chosen), crop: { x: 0.3, y: 0.5, zoom: 1.5 } });
    expect(out).toEqual({ url: `https://api.example.test/api/users/${ME}/avatar?v=${(db.row.avatar_updated_at as Date).getTime()}` });
    expect(Buffer.compare(db.row.avatar_source_blob as Buffer, chosen)).toBe(0);
    expect(db.row.avatar_source_mime).toBe('image/jpeg');
    expect(JSON.parse(db.row.avatar_crop as string)).toEqual({ x: 0.3, y: 0.5, zoom: 1.5 });
    expect(await sizeOf(db.row.avatar_blob as Buffer)).toEqual({ width: 1000, height: 1000, format: 'jpeg' });
    expect(db.row.avatar_blob_type).toBe('image/jpeg');
    expect(db.row.avatar_url).toBe(out.url);
  });

  it('a picture with no crop is placed in the middle', async () => {
    await savePicture('avatar', ME, { image: dataUrl('image/png', await solid(3000, 2000, RED, 'png')) });
    expect(JSON.parse(db.row.avatar_crop as string)).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
    expect(await sizeOf(db.row.avatar_blob as Buffer)).toEqual({ width: 1024, height: 1024, format: 'jpeg' });
  });

  it('a banner keeps its chosen picture and crop, and the 2400 by 800 banner, at the banner\'s address', async () => {
    const chosen = await solid(4000, 3000, BLUE, 'webp');
    const out = await savePicture('banner', ME, { image: dataUrl('image/webp', chosen), crop: { x: 0.5, y: 0.2, zoom: 1 } });
    expect(out.url).toBe(`https://api.example.test/api/users/${ME}/banner?v=${(db.row.banner_updated_at as Date).getTime()}`);
    expect(Buffer.compare(db.row.banner_source_blob as Buffer, chosen)).toBe(0);
    expect(db.row.banner_source_mime).toBe('image/webp');
    expect(db.row.banner_mime).toBe('image/jpeg');
    expect(await sizeOf(db.row.banner_blob as Buffer)).toEqual({ width: 2400, height: 800, format: 'jpeg' });
  });

  it('refuses a GIF for a photo in the photo\'s own words, and keeps nothing', async () => {
    const gif = Buffer.from('GIF89a' + 'x'.repeat(100), 'latin1');
    await expect(savePicture('avatar', ME, { image: dataUrl('image/gif', gif) })).rejects.toThrow('Choose a JPG, PNG or WebP picture for your photo.');
    expect(db.writes).toHaveLength(0);
  });

  it('a member who is gone is a 404', async () => {
    await expect(savePicture('avatar', '00000000-0000-4000-8000-000000000000', { image: dataUrl('image/jpeg', await solid(100, 100)) }))
      .rejects.toThrow('This account is no longer available.');
  });
});

describe('savePicture (placed again, with no new picture)', () => {
  it('cuts the new crop from the kept picture: the kept picture is not written again, only the crop and what is shown', async () => {
    const chosen = await halves(2000, 1000, RED, BLUE);
    await savePicture('avatar', ME, { image: dataUrl('image/jpeg', chosen), crop: { x: 0.25, y: 0.5, zoom: 1 } });
    expect(near(await colourAt(db.row.avatar_blob as Buffer, 500, 500), RED)).toBe(true);
    const firstUrl = db.row.avatar_url;
    db.writes.length = 0;

    const out = await savePicture('avatar', ME, { crop: { x: 0.75, y: 0.5, zoom: 1 } });
    expect(near(await colourAt(db.row.avatar_blob as Buffer, 500, 500), BLUE)).toBe(true);
    expect(JSON.parse(db.row.avatar_crop as string)).toEqual({ x: 0.75, y: 0.5, zoom: 1 });
    expect(Buffer.compare(db.row.avatar_source_blob as Buffer, chosen)).toBe(0);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].sql).not.toMatch(/avatar_source_blob/);
    expect(out.url).toBe(db.row.avatar_url);
    expect(typeof firstUrl).toBe('string');
  });

  it('a photo captured before (LinkedIn, Google, Gravatar) with nothing kept is placed from the photo itself, which is then kept', async () => {
    const captured = await solid(200, 200, RED);
    db.row.avatar_blob = captured;
    db.row.avatar_blob_type = 'image/jpeg';
    await savePicture('avatar', ME, { crop: { x: 0.5, y: 0.5, zoom: 2 } });
    expect(Buffer.compare(db.row.avatar_source_blob as Buffer, captured)).toBe(0);
    expect(db.row.avatar_source_mime).toBe('image/jpeg');
    expect(await sizeOf(db.row.avatar_blob as Buffer)).toEqual({ width: 100, height: 100, format: 'jpeg' });
  });

  it('with no picture at all, asks for one in a sentence and writes nothing', async () => {
    await expect(savePicture('avatar', ME, { crop: { x: 0.5, y: 0.5, zoom: 1 } })).rejects.toThrow('Choose a picture first.');
    await expect(savePicture('banner', ME, {})).rejects.toThrow('Choose a picture first.');
    expect(db.writes).toHaveLength(0);
  });
});

describe('getPictureSource', () => {
  it('gives the kept picture and where it was placed', async () => {
    const chosen = await solid(800, 600, BLUE, 'png');
    db.row.banner_source_blob = chosen;
    db.row.banner_source_mime = 'image/png';
    db.row.banner_crop = { x: 0.4, y: 0.5, zoom: 1.2 };
    expect(await getPictureSource('banner', ME)).toEqual({ image: dataUrl('image/png', chosen), crop: { x: 0.4, y: 0.5, zoom: 1.2 } });
  });

  it('with nothing kept, gives the picture everyone sees, never placed', async () => {
    const captured = await solid(200, 200);
    db.row.avatar_blob = captured;
    db.row.avatar_blob_type = 'image/jpeg';
    expect(await getPictureSource('avatar', ME)).toEqual({ image: dataUrl('image/jpeg', captured), crop: null });
  });

  it('with no picture at all, gives none', async () => {
    expect(await getPictureSource('avatar', ME)).toEqual({ image: null, crop: null });
  });
});
