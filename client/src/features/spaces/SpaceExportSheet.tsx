// client/src/features/spaces/SpaceExportSheet.tsx
// "Export" for the people who run a circle or a pod (Shirley pilot S7, item 20; plan decision D6): four spreadsheet
// files, each downloaded on its own, with what is and is not in them said first (brief, "Data ownership and
// portability": joining is not consent to private data leaving REASON). Every download is recorded before it leaves;
// the sheet says so. Portalled to <body> by Sheet; every button is 44px tall; it scrolls inside itself at 360px.
// A download changes nothing on any screen, so there is no query here and nothing to refresh.
import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { SPACE_EXPORT_COPY, SPACE_EXPORT_SECTIONS, type SpaceExportSection, type SpaceKind } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { gotNoAnswer } from '@/features/reason/errors';
import { downloadSpaceFile } from './download-space-file';
import { downloadFailedLine, refusalMessage } from './space-export';

interface Props { kind: SpaceKind; spaceId: string; name: string; onClose: () => void }

const statusOf = (err: unknown) => (err as { response?: { status?: number } } | null)?.response?.status;

export default function SpaceExportSheet({ kind, spaceId, name, onClose }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const [busy, setBusy] = useState<SpaceExportSection | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A ref as well as state: a double tap lands before React draws the button as busy.
  const sending = useRef(false);

  const download = async (section: SpaceExportSection) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(section);
    setError(null);
    try {
      await downloadSpaceFile(kind, spaceId, section);
      addToast(`${SPACE_EXPORT_COPY[section].label} file downloaded.`, 'success');
    } catch (err) {
      setError(downloadFailedLine(statusOf(err), await refusalMessage(err), kind, gotNoAnswer(err)));
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  return (
    <Sheet open onClose={onClose} title={`Export ${name}`}>
      <div className="mt-3 grid gap-3 pb-1 text-sm text-gray-700" data-testid="space-export-sheet">
        <p>
          Download this {kind}&apos;s data as spreadsheet files (CSV). Each download is recorded first, with your name,
          the time and which file you took.
        </p>
        <p className="rounded-xl bg-gray-50 p-3 text-[13px] text-gray-600">
          Never included: email addresses, private profile details, messages, other people&apos;s posts and comments,
          and anyone you have blocked or who has blocked you. People who left or were removed are a count only.
        </p>
        <ul className="grid gap-2">
          {SPACE_EXPORT_SECTIONS.map((section) => (
            <li key={section} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200 p-3">
              <div className="min-w-0 flex-1 basis-[180px]">
                <p className="font-semibold text-[#1a1a2e]">{SPACE_EXPORT_COPY[section].label}</p>
                <p className="text-[13px] text-gray-500">{SPACE_EXPORT_COPY[section].holds}</p>
              </div>
              <Button
                variant="secondary" onClick={() => void download(section)} isLoading={busy === section}
                disabled={busy !== null && busy !== section} data-testid={`space-export-${section}`}
                aria-label={`Download ${SPACE_EXPORT_COPY[section].label.toLowerCase()} file`}
              >
                {busy !== section && <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />} Download
              </Button>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
      </div>
    </Sheet>
  );
}
