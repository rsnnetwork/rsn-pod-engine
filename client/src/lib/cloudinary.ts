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

// Feature 20 (13 May spec) — voice messages. MediaRecorder typically produces
// audio/webm on Chrome/Edge and audio/mp4 on Safari. Cloudinary's /auto/upload
// accepts both via its video resource type. 5 MB ≈ ~5 minutes of compressed
// voice, more than enough for the speed-networking use case.
export const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg'] as const;
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 5 * 60 * 1000; // 5 min hard cap

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

export interface CloudinaryAudioResult {
  url: string;
  durationSec: number;
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

/**
 * Validate an audio blob produced by MediaRecorder before uploading.
 */
export function validateAudioBlob(blob: Blob, durationMs: number): ValidationFailure | null {
  if (!isCloudinaryConfigured()) {
    return { reason: 'unconfigured', message: 'Audio upload is not configured for this deployment' };
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    return { reason: 'too-large', message: 'Voice message is over the 5 MB limit' };
  }
  if (durationMs > MAX_AUDIO_DURATION_MS) {
    return { reason: 'too-large', message: 'Voice message is over the 5 minute limit' };
  }
  return null;
}

/**
 * Upload a recorded audio blob to Cloudinary. Audio uploads through the
 * /video/upload endpoint (Cloudinary classifies audio as a video resource).
 * The unsigned upload preset must have resource_type set to "auto" (or
 * "video") so the preset accepts the blob — the operator setup notes call
 * this out.
 */
export async function uploadAudioToCloudinary(
  blob: Blob,
  durationMs: number,
  onProgress?: (fraction: number) => void,
): Promise<CloudinaryAudioResult> {
  if (!isCloudinaryConfigured()) {
    throw new Error('Cloudinary is not configured');
  }
  const failure = validateAudioBlob(blob, durationMs);
  if (failure) {
    throw new Error(failure.message);
  }

  // MediaRecorder doesn't reliably give us a filename, so we fabricate one.
  // The extension hints to Cloudinary; the preset's resource_type=auto does
  // the rest.
  const ext = blob.type.includes('webm') ? 'webm'
    : blob.type.includes('mp4') ? 'mp4'
    : blob.type.includes('ogg') ? 'ogg'
    : 'webm';
  const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type || 'audio/webm' });

  const form = new FormData();
  form.append('file', file);
  form.append('upload_preset', UPLOAD_PRESET!);

  return new Promise<CloudinaryAudioResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // /auto/upload lets Cloudinary pick the resource type. Works for audio
    // blobs as long as the preset is configured for resource_type=auto.
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as {
            secure_url: string; duration?: number; bytes: number; format: string;
          };
          resolve({
            url: body.secure_url,
            durationSec: body.duration ?? Math.round(durationMs / 1000),
            bytes: body.bytes,
            format: body.format,
          });
        } catch {
          reject(new Error('Could not parse Cloudinary response'));
        }
      } else {
        reject(new Error(`Cloudinary upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error uploading voice message'));
    xhr.send(form);
  });
}
