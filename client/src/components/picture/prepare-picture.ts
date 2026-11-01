// client/src/components/picture/prepare-picture.ts
// A chosen picture made ready to send (30 Oct review, T3a). The server keeps the member's own picture and cuts what
// everyone sees from it, so the file is sent as it is whenever it can be (picture-file.ts). A bigger one is copied
// smaller here first: shrunk in halving steps with the browser's best smoothing (one big low-quality step is what
// made uploads jagged before), as a JPEG on white, until it fits the server's 3 MB and 4096 pixels.
import { PICTURE_SEND_MAX_BYTES, PICTURE_SEND_MAX_SIDE, sendsAsItIs } from './picture-file';

export const UNREADABLE_PICTURE = 'We could not read that picture. Please choose another one.';
export const PICTURE_TOO_LARGE = 'That picture is too large. Please choose a smaller one.';

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(UNREADABLE_PICTURE)));
    reader.onerror = () => reject(new Error(UNREADABLE_PICTURE));
    reader.readAsDataURL(file);
  });
}

function openPicture(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(UNREADABLE_PICTURE)); };
    img.src = url;
  });
}

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(UNREADABLE_PICTURE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [canvas, ctx];
}

/** The picture at most `maxSide` on its longer side, as a JPEG data URL: halved step by step, then drawn on white. */
function drawSmaller(img: HTMLImageElement, maxSide: number, quality: number): string {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  let source: HTMLImageElement | HTMLCanvasElement = img;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  while (w / 2 >= width && h / 2 >= height) {
    const [half, ctx] = canvasOf(Math.round(w / 2), Math.round(h / 2));
    ctx.drawImage(source, 0, 0, half.width, half.height);
    source = half;
    w = half.width;
    h = half.height;
  }
  const [out, ctx] = canvasOf(width, height);
  // A JPEG has no transparency: a see-through PNG would turn black without a white ground under it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return out.toDataURL('image/jpeg', quality);
}

const bytesIn = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** The chosen file as the data URL to send: itself when it can be, else a smaller copy. Throws a sentence. */
export async function pictureToSend(file: Blob): Promise<string> {
  const img = await openPicture(file);
  if (sendsAsItIs(file, { width: img.naturalWidth, height: img.naturalHeight })) return readAsDataUrl(file);
  for (const side of [PICTURE_SEND_MAX_SIDE, 3072, 2048]) {
    for (const quality of [0.92, 0.85]) {
      const copy = drawSmaller(img, side, quality);
      if (bytesIn(copy) <= PICTURE_SEND_MAX_BYTES) return copy;
    }
  }
  throw new Error(PICTURE_TOO_LARGE);
}
