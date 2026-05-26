// Copies the MediaPipe tasks-vision WASM fileset out of node_modules into
// public/mediapipe/wasm so the background-effects model loads from OUR origin
// instead of a public CDN at runtime. Self-hosting matters at scale: 500 users
// hitting jsDelivr at event start is slow/unreliable and can hang init.
//
// Runs as part of `dev` and `build` (incl. on Vercel, where `cd client && npm
// run build` executes this). The .tflite model + preset images are committed
// directly under public/; only the bulky WASM is copied from node_modules and
// gitignored.
import { cpSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');

// tasks-vision is a transitive dep of @livekit/track-processors; it may live in
// the client's node_modules or be hoisted to the monorepo root.
const candidates = [
  join(clientRoot, 'node_modules/@mediapipe/tasks-vision/wasm'),
  join(clientRoot, '../node_modules/@mediapipe/tasks-vision/wasm'),
];
const from = candidates.find((p) => existsSync(p));

const dest = join(clientRoot, 'public/mediapipe/wasm');

if (!from) {
  // Don't fail the build — the runtime HEAD-probe falls back to the CDN if the
  // self-hosted fileset is missing.
  console.warn('[copy-mediapipe] @mediapipe/tasks-vision/wasm not found; skipping (runtime will use CDN fallback).');
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(from, dest, { recursive: true });
console.log(`[copy-mediapipe] copied ${from} -> ${dest}`);
