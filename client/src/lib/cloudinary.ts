// Cloudinary direct-upload helper.
//
// Feature 19 (13 May spec) — DM image attachments. The client uploads
// directly to Cloudinary using an unsigned upload preset so the server
// never has to proxy the bytes. The preset (configured in Cloudinary's
// dashboard) enforces:
//   • allowed_formats: jpg, png, webp, gif
//   • max_file_size: 10485760  (10 MB)
//   • folder: rsn-dm-attachments
//   • access_mode: public
// If either env var is missing, isCloudinaryConfigured() returns false
// and the client hides the upload affordance — the feature is purely
// additive.
//
// Setup steps for the operator:
//   1. Create a Cloudinary account → grab the cloud name.
//   2. Settings → Upload → Add upload preset → "Unsigned", restrict
//      formats + size as above. Name it e.g. "rsn-dm-unsigned".
//   3. Set VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET
//      in Vercel project env → Production. Redeploy.

const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
const UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string | undefined;

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — matches the preset cap

export function isCloudinaryConfigured(): boolean {
  return !!CLOUD_NAME && !!UPLOAD_PRESET;
}

export interface CloudinaryImageResult {
  url: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
}

export interface ValidationFailure {
  reason: 'unconfigured' | 'wrong-type' | 'too-large';
  message: string;
}

export function validateImageFile(file: File): ValidationFailure | null {
  if (!isCloudinaryConfigured()) {
    return {
      reason: 'unconfigured',
      message: 'Image upload is not configured for this deployment',
    };
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.type as any)) {
    return {
      reason: 'wrong-type',
      message: 'Only JPG, PNG, WebP, or GIF images are supported',
    };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      reason: 'too-large',
      message: 'Image is over the 10 MB limit',
    };
  }
  return null;
}

/**
 * Upload a single image file to Cloudinary via the unsigned upload preset.
 * Reports progress to the optional callback (0..1).
 *
 * Returns the resulting secure URL + the metadata fields we want to store
 * alongside the message (so the recipient can render an aspect-correct
 * placeholder before the image actually loads).
 */
export async function uploadImageToCloudinary(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<CloudinaryImageResult> {
  if (!isCloudinaryConfigured()) {
    throw new Error('Cloudinary is not configured');
  }
  const failure = validateImageFile(file);
  if (failure) {
    throw new Error(failure.message);
  }

  const form = new FormData();
  form.append('file', file);
  form.append('upload_preset', UPLOAD_PRESET!);

  return new Promise<CloudinaryImageResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded / e.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as {
            secure_url: string; width: number; height: number; bytes: number; format: string;
          };
          resolve({
            url: body.secure_url,
            width: body.width,
            height: body.height,
            bytes: body.bytes,
            format: body.format,
          });
        } catch (err) {
          reject(new Error('Could not parse Cloudinary response'));
        }
      } else {
        reject(new Error(`Cloudinary upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error uploading image'));
    xhr.send(form);
  });
}
