// client/src/components/wall/ReportPostButton.tsx
// "Report post" on someone else's post (11 Nov 2026, Shirley Palmer's item 16: make abusive content reportable without
// leaving where it is). A labelled action in the post's row of controls, never a lone icon; it opens the report sheet
// with the post quoted, which says what happens before it is sent. Not drawn on the viewer's own posts (the server
// refuses those too). The reader stays on the wall.
import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ReportSubjectKind } from '@rsn/shared';
import ReportUserModal from '@/components/ReportUserModal';
import { REPORT_POST } from '@/components/safety/safety-words';

export default function ReportPostButton({ kind, postId, authorId, authorName, excerpt, className }: {
  kind: Extract<ReportSubjectKind, 'pod_post' | 'circle_post'>;
  postId: string;
  authorId: string;
  authorName: string | null;
  excerpt: string;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} data-testid={`report-post-${postId}`}>
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
        {REPORT_POST}
      </button>
      <ReportUserModal
        open={open}
        onClose={() => setOpen(false)}
        reportedId={authorId}
        reportedDisplayName={authorName}
        subject={{ kind, id: postId, excerpt }}
      />
    </>
  );
}
