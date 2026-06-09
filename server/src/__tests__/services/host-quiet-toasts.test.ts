// Host-quiet toasts (2026-06-09, Ali). The host runs the event and the UI
// already reflects every action, so confirmation banners (info / success) piled
// up on every button press ("Plan updated for round 2", match hints, etc.) plus
// a non-actionable "No match data available to rate" error. The host must see
// ONLY actionable errors; participants keep seeing all their toasts. These pins
// lock the wiring (the runtime behaviour is a pure DOM filter, exercised here as
// source-pins in the same style as the BG architecture suite).
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('Host-quiet toasts', () => {
  const store = clientSrc('stores/toastStore.ts');
  const toast = clientSrc('components/ui/Toast.tsx');
  const live = clientSrc('features/live/LiveSessionPage.tsx');
  const rating = clientSrc('features/live/RatingPrompt.tsx');

  it('the toast store carries an optional hostSilent flag through addToast', () => {
    expect(store).toMatch(/hostSilent\?: boolean/);
    expect(store).toMatch(/addToast: \(message: string, type: Toast\['type'\], opts\?: ToastOptions\)/);
    // the flag is persisted onto the toast it creates
    expect(store).toMatch(/hostSilent: opts\?\.hostSilent/);
  });

  it('ToastContainer hostQuiet mode shows the host ONLY non-silent errors', () => {
    expect(toast).toMatch(/hostQuiet\?: boolean/);
    expect(toast).toMatch(/export default function ToastContainer\(\{ hostQuiet = false \}: Props\)/);
    // info / success are dropped for the host; errors survive unless hostSilent
    expect(toast).toMatch(/hostQuiet[\s\S]*toasts\.filter\(t => t\.type === 'error' && !t\.hostSilent\)/);
    // the render loop iterates the filtered list, not the raw store
    expect(toast).toMatch(/\{visible\.map\(t =>/);
  });

  it('the live event page runs the host in hostQuiet mode', () => {
    expect(live).toMatch(/<ToastContainer hostQuiet=\{isHost\} \/>/);
  });

  it('the non-actionable "no match data" notice is hostSilent', () => {
    expect(rating).toMatch(/addToast\('No match data available to rate', 'error', \{ hostSilent: true \}\)/);
  });
});
