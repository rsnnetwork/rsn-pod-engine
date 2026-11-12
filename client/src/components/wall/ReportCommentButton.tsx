// client/src/components/wall/ReportCommentButton.tsx
// "Report comment" on someone else's comment or reply (11 Nov 2026, Shirley Palmer's item 16; controller ruling, fix
// round 1). A labelled action in the comment's own row, never a lone icon; it opens the report sheet with the comment
// quoted, which says what happens before it is sent. Not drawn on the viewer's own comments (the server refuses those
// too). The reader stays on the wall. The wall says which kind of comment it holds (WallConfig.reportKind).
import { useState } from 'react';
import ReportUserModal from '@/components/ReportUserModal';
import { REPORT_COMMENT } from '@/components/safety/safety-words';

export default function ReportCommentButton({ kind, commentId, authorId, authorName, excerpt }: {
  kind: 'pod_post' | 'circle_post';
  commentId: string;
  authorId: string;
  authorName: string | null;
  excerpt: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] min-w-[44px] px-2 text-xs font-semibold text-gray-500 hover:text-gray-800"
        data-testid={`report-comment-${commentId}`}
      >
        {REPORT_COMMENT}
      </button>
      <ReportUserModal
        open={open}
        onClose={() => setOpen(false)}
        reportedId={authorId}
        reportedDisplayName={authorName}
        subject={{ kind: kind === 'pod_post' ? 'pod_comment' : 'circle_comment', id: commentId, excerpt }}
      />
    </>
  );
}
