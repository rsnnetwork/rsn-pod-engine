// ─── Encryption at rest for calendar tokens (Shirley pilot S8, D7) ───────────────────────────────────────────────────
//
// AES-256-GCM with a fresh random 12-byte IV for every seal. What is stored is one buffer: IV (12) | tag (16) |
// ciphertext. The "additional data" names what the plaintext is and whose it is (for a token: the member, the provider
// and which token), so a ciphertext copied onto another member's row, or an access token passed off as a refresh
// token, fails to open: GCM refuses it exactly as it refuses one sealed under another key or edited by a single bit.
//
// The OAuth envelopes (oauth-envelope.ts) use a key DERIVED from the token key (HKDF-SHA256 with its own label), so
// nothing that travels in a URL is ever sealed under the key that guards the stored tokens.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Opening failed: the wrong key, a ciphertext edited or moved, or not a sealed value at all. Never says which. */
export class SecretBoxError extends Error {
  constructor() {
    super('The sealed value could not be opened');
    this.name = 'SecretBoxError';
  }
}

export function seal(key: Buffer, plaintext: string, additionalData: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** `sealed` as the database driver hands it back: node-postgres gives a Buffer for BYTEA, other drivers a Uint8Array. */
export function open(key: Buffer, sealedBytes: Buffer | Uint8Array, additionalData: string): string {
  const sealed = sealedBytes instanceof Uint8Array ? Buffer.from(sealedBytes) : null;
  if (!sealed || sealed.length < IV_BYTES + TAG_BYTES) throw new SecretBoxError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(additionalData, 'utf8'));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError();
  }
}

/** A 32-byte key for one purpose, derived from the master key (HKDF-SHA256). */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `rsn-calendar:${purpose}`, 32));
}

/** What a stored token's seal is bound to: the member, the provider and which token. */
export const tokenAad = (userId: string, provider: string, which: 'refresh' | 'access') =>
  `calendar-token:${userId}:${provider}:${which}`;
