// ─── "Upload a new one": a photo made small in the browser ─────────────────
//
// A phone photo is several megabytes; the profile takes a data URL of up to two
// million characters (PUT /users/me). So the picture is drawn onto a canvas at
// most 800 pixels a side and sent as a JPEG, which is what the profile page's
// own upload does too. Transparent PNGs get a white background rather than
// black, which is what a JPEG would otherwise give them.

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const MAX_SIDE = 800;
/** Under the server's two million characters, with room to spare. */
const MAX_CHARS = 1_900_000;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** The photo as a small JPEG data URL, or null when the browser cannot read it. */
export async function shrinkPhoto(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (!img) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.length <= MAX_CHARS) return data;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
