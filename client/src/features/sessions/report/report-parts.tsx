// ─── Pieces the report card and the report page share (Part 3 Task 9) ──────────────────────────────────────────────
// The six summary tiles (two to a row on a phone, three from 640px) and the three download buttons (stacked full width
// on a phone, side by side from 640px, each 44px tall with its own spinner).
import { Download, Loader2 } from 'lucide-react';
import type { EventReportSection, EventReportSummary } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { QUIET_BUTTON } from '../organiser-ui';
import { DOWNLOADS, reportTiles } from './report-text';

export function ReportTiles({ summary }: { summary: EventReportSummary }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {reportTiles(summary).map((tile) => (
        <div key={tile.key} data-testid={`report-tile-${tile.key}`} className="min-w-0 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
          <p className="text-2xl font-bold text-[#1a1a2e]">
            {tile.value}
            {tile.note && <span className="ml-1 text-sm font-medium text-gray-500">{tile.note}</span>}
          </p>
          <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">{tile.label}</p>
        </div>
      ))}
    </div>
  );
}

export function ReportDownloads({ busy, onDownload }: {
  busy: EventReportSection | null;
  onDownload: (section: EventReportSection) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {DOWNLOADS.map(({ section, label }) => (
        <button
          key={section}
          type="button"
          data-testid={`report-download-${section}`}
          onClick={() => onDownload(section)}
          disabled={busy !== null}
          aria-busy={busy === section}
          className={cn(QUIET_BUTTON, 'w-full sm:w-auto')}
        >
          {busy === section
            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <Download className="h-4 w-4" aria-hidden="true" />}
          {label}
        </button>
      ))}
    </div>
  );
}
