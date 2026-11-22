// ─── One part of the event report as a spreadsheet file (Part 3 Task 9, over Task 4's CSV) ─────────────────────────
// The server builds the file (a UTF-8 BOM, every cell formula-guarded, times on the event's clock) and writes each
// download into the event's history. The browser only saves what it is sent: the request goes through lib/api.ts, so
// it carries the member's sign-in, and the answer is read as a blob. Never a new tab or window: it would send no sign-in.

import type { EventReport, EventReportSection } from '@rsn/shared';
import api from '@/lib/api';
import { reportFileName } from './report-text';

/** How long the saved file's address stays valid: Safari reads it after the click returns. */
const KEEP_FILE_MS = 60_000;

/** Fetch one section's CSV and hand it to the browser as a download. Throws what the request threw. */
export async function downloadReportSection(
  sessionId: string,
  section: EventReportSection,
  report: Pick<EventReport, 'event' | 'generatedAt'> | null | undefined,
): Promise<void> {
  const res = await api.get<Blob>(`/sessions/${sessionId}/report`, {
    params: { format: 'csv', section },
    responseType: 'blob',
  });
  const blob = res.data instanceof Blob ? res.data : new Blob([res.data], { type: 'text/csv;charset=utf-8' });
  const disposition = res.headers?.['content-disposition'];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = reportFileName(section, report, typeof disposition === 'string' ? disposition : null);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_FILE_MS);
}
