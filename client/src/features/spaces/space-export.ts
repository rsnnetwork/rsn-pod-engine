// client/src/features/spaces/space-export.ts
// An organiser's export of their circle or pod (Shirley pilot S7, item 20; plan decision D6). The rules of who sees the
// Export entry, the file's name and what a refusal says are pure, so the server's jest runs them:
// server/src/__tests__/client/s7-client.test.ts. The download itself is in download-space-file.ts.
//
// The server decides who may export (a circle's owner and moderators, a pod's director and hosts) and refuses anyone
// else; the page only hides the entry from people it would refuse. A platform admin with no such role is refused too.
import type { CircleRole, SpaceExportSection, SpaceKind } from '@rsn/shared';
import { memberSentence } from '../reason/errors';

/** A circle's Export entry: its owner and moderators. */
export const mayExportCircle = (myRole: CircleRole | null | undefined) => myRole === 'owner' || myRole === 'moderator';

/** A pod's Export entry: its active director and hosts (`role` is the viewer's active pod role, or null). */
export const mayExportPod = (role: string | null | undefined) => role === 'director' || role === 'host';

const FILE_NAME = /^reason-(circle|pod)-(space|members|events|posts)-\d{4}-\d{2}-\d{2}\.csv$/;

/** The name to save the file under: the server's, when it is one of its own shapes; else one made here from today's date. */
export function exportFileName(kind: SpaceKind, section: SpaceExportSection, disposition: string | null, today: Date = new Date()): string {
  const named = disposition?.match(/filename="([^"]+)"/)?.[1] ?? null;
  if (named && FILE_NAME.test(named)) return named;
  const day = today.toISOString().slice(0, 10);
  return `reason-${kind}-${section}-${day}.csv`;
}

interface FailedDownload { response?: { status?: number; data?: unknown }; request?: unknown; isAxiosError?: unknown }

/**
 * The body of a refused download. Asked for as a blob, so the server's JSON refusal arrives as a Blob; read it as text.
 * Anything that is not the server's { error: { message } } gives null.
 */
export async function refusalMessage(err: unknown): Promise<string | null> {
  const data = (err as FailedDownload | null)?.response?.data;
  let body: unknown = data;
  try {
    if (data && typeof (data as Blob).text === 'function') body = JSON.parse(await (data as Blob).text());
  } catch {
    return null; // Not JSON: no sentence of the server's to pass on.
  }
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' ? message : null;
}

/** One sentence for a download that failed: the server's own words when they are fit to show, else plain ones. */
export function downloadFailedLine(status: number | undefined, serverMessage: string | null, kind: SpaceKind, gotNoAnswer: boolean): string {
  if (status === undefined) return gotNoAnswer ? 'Connection lost. Check your internet and try again.' : 'Could not download that file just now. Try again in a moment.';
  // An archived circle stays exportable by its owner and moderators, so a 404 means it is gone or they no longer run it.
  if (status === 404) return `This ${kind} could not be found, or you no longer run it.`;
  if (status === 403 || status === 429 || status === 400) {
    return memberSentence(serverMessage) ?? (status === 429 ? 'Slow down a moment, then try again.' : 'You cannot download this file.');
  }
  return 'Could not download that file just now. Try again in a moment.';
}
