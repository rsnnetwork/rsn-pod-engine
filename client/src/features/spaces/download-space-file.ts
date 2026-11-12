// client/src/features/spaces/download-space-file.ts
// One file of an organiser's export, saved by the browser (Shirley pilot S7, item 20). The server builds it (a UTF-8
// BOM, every cell formula-guarded) and writes each download to its access log before sending it. The request goes
// through lib/api.ts, so it carries the member's sign-in, and the answer is read as a blob. Never a new tab or window:
// it would send no sign-in.
import type { SpaceExportSection, SpaceKind } from '@rsn/shared';
import api from '@/lib/api';
import { exportFileName } from './space-export';

/** How long the saved file's address stays valid: Safari reads it after the click returns. */
const KEEP_FILE_MS = 60_000;

/** Fetch one file and hand it to the browser as a download. Throws what the request threw. */
export async function downloadSpaceFile(kind: SpaceKind, spaceId: string, section: SpaceExportSection): Promise<void> {
  const res = await api.get<Blob>(`/${kind === 'circle' ? 'circles' : 'pods'}/${encodeURIComponent(spaceId)}/export`, {
    params: { section },
    responseType: 'blob',
  });
  const blob = res.data instanceof Blob ? res.data : new Blob([res.data], { type: 'text/csv;charset=utf-8' });
  const disposition = res.headers?.['content-disposition'];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName(kind, section, typeof disposition === 'string' ? disposition : null);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_FILE_MS);
}
