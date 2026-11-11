// ─── Circles you ran (archived), with their export (Shirley pilot S7 fix round 1; item 20, D6) ──────────────────
// An archived circle's page stays closed, but its owner and moderators keep their copy of its data ("organisers should
// be able to export if they leave"). This lists the archived circles the member is still owner or moderator of
// (GET /circles/archived/mine; nobody else's) and opens the export sheet for one. Shown only when there is one. It
// follows the member's own circles (user:<me>:circles, sent when a circle they are in is archived or their role in it
// changes). Each row's Export is 44px; the sheet is the portalled SpaceExportSheet.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, Download } from 'lucide-react';
import type { ArchivedCircleRun } from '@rsn/shared';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import SpaceExportSheet from '@/features/spaces/SpaceExportSheet';

const ROLE_WORDS: Record<ArchivedCircleRun['myRole'], string> = { owner: 'You owned it', moderator: 'You moderated it' };

export default function ArchivedCirclesSection() {
  const me = useAuthStore((s) => s.user?.id);
  const [exporting, setExporting] = useState<ArchivedCircleRun | null>(null);
  const { data, isError, refetch } = useQuery<ArchivedCircleRun[]>({
    queryKey: ['circles', 'archived-mine'],
    queryFn: () => api.get('/circles/archived/mine').then((r) => r.data.data ?? []),
    enabled: !!me,
    meta: { entities: me ? [E.userCircles(me)] : [] },
  });

  if (isError) {
    return (
      <Card data-testid="circles-archived-error">
        <p className="text-sm text-gray-700" role="alert">We could not load the archived circles you ran.</p>
        <Button variant="secondary" className="mt-3" onClick={() => void refetch()}>Try again</Button>
      </Card>
    );
  }
  if (!data || data.length === 0) return null;

  return (
    <section aria-labelledby="circles-archived-title" className="space-y-2 animate-fade-in-up" data-testid="circles-archived">
      <h2 id="circles-archived-title" className="flex items-center gap-1.5 text-sm font-semibold text-gray-700">
        <Archive className="h-4 w-4 text-rsn-red" aria-hidden="true" /> Circles you ran (archived)
      </h2>
      <p className="text-xs text-gray-500">Their pages are closed. You can still download their data.</p>
      <div className="grid gap-2">
        {data.map((c) => (
          <Card key={c.id} className="!p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1 basis-[160px]">
                <p className="font-medium text-gray-900 break-words">{c.name}</p>
                <p className="text-xs text-gray-500">
                  {ROLE_WORDS[c.myRole]} · Archived {new Date(c.archivedAt).toLocaleDateString()}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setExporting(c)} data-testid={`circle-archived-export-${c.id}`}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden="true" /> Export
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {exporting && (
        <SpaceExportSheet kind="circle" spaceId={exporting.id} name={exporting.name} onClose={() => setExporting(null)} />
      )}
    </section>
  );
}
