// This tab's copy of the page to come back to after sign-in (return-path.ts says why). Google and the code finish in
// the tab that started, so sessionStorage, which stays with the tab across Google's round trip, is the place for it.
import { safeReturnPath } from './return-path';

const STORAGE_KEY = 'rsn_redirect';

/** Keep the page for this tab (Google and the code finish in it). */
export function rememberReturnPath(path: string): void {
  sessionStorage.setItem(STORAGE_KEY, path);
}

/** The page this tab kept, once: it is forgotten as it is read. */
export function takeReturnPath(): string | null {
  const kept = safeReturnPath(sessionStorage.getItem(STORAGE_KEY));
  sessionStorage.removeItem(STORAGE_KEY);
  return kept;
}
