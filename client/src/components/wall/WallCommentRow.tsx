// One comment or reply: who wrote it, when, "Edited", its words cut at six lines (or its author's edit in their place),
// and the buttons the viewer may use: Like, Reply (top-level comments), Edit (its author while they may post) and Delete
// (its author, or a moderator). Its replies and the reply box are drawn under it by the caller (`children`). Split out
// of WallComments in S4 fix round 1.
//
// A comment its author deleted while it had replies (withdrawn) says "This comment was deleted." without a name or a
// picture, and keeps its replies under it; only a moderator still has a button there, to remove it with its thread.
// Someone else's comment can be reported from its row (S5, item 16; a moderator sees Report comment beside Delete);
// the placeholder cannot, since it has no author and no words.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CornerDownRight, Trash2 } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import ClampedText from './ClampedText';
import ReportCommentButton from './ReportCommentButton';
import { EDITED_LABEL, WITHDRAWN_COMMENT, canDeleteWallItem, canEditWallItem, timeAgo } from './wall-logic';
import type { WallComment, WallConfig, WallViewer } from './wall-types';

const textButton = 'min-h-[44px] min-w-[44px] px-2 text-xs font-semibold text-gray-500 hover:text-gray-800';
const deleteButton = 'flex min-h-[44px] min-w-[44px] items-center justify-center px-2 text-gray-300 hover:text-red-500';

export default function WallCommentRow({
  config, comment: c, isReply, viewer, userId, canLike, editForm, onLike, onReply, onEdit, onDelete, children,
}: {
  config: WallConfig;
  comment: WallComment;
  isReply: boolean;
  viewer: WallViewer;
  userId: string | undefined;
  /** Someone who cannot post still sees how many likes a comment has; they just have no button. */
  canLike: boolean;
  /** The author's open edit of this comment, drawn in place of its words. */
  editForm: ReactNode | null;
  onLike: () => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  children?: ReactNode;
}) {
  if (c.withdrawn) {
    return (
      <div className="min-w-0" data-testid={`comment-${c.id}`}>
        <div className="flex items-center gap-1">
          <p className="min-w-0 flex-1 rounded-lg bg-gray-50 px-2.5 py-1.5 text-sm italic text-gray-500" data-testid={`comment-withdrawn-${c.id}`}>
            {WITHDRAWN_COMMENT}
          </p>
          {viewer.canModerate && (
            <button type="button" onClick={onDelete} aria-label="Delete comment and replies" className={deleteButton} data-testid={`comment-delete-${c.id}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {children}
      </div>
    );
  }

  const href = !c.authorClosed && config.authorHref ? config.authorHref(c.authorId) : null;
  const avatar = <Avatar src={c.authorAvatarUrl || undefined} name={c.authorName || 'Member'} size="sm" />;
  return (
    <div className={`flex items-start gap-2 ${isReply ? 'ml-8' : ''}`} data-testid={`comment-${c.id}`}>
      {isReply && <CornerDownRight className="mt-2 h-3 w-3 shrink-0 text-gray-300" aria-hidden />}
      {href ? (
        // A 44px target around the 32px picture; the negative margin keeps the row where it was.
        <Link to={href} className="-m-1.5 flex h-11 w-11 shrink-0 items-center justify-center" aria-label={`${c.authorName || 'Member'}'s profile`}>
          {avatar}
        </Link>
      ) : avatar}
      <div className="min-w-0 flex-1">
        <div className="bg-gray-50 rounded-lg px-2.5 py-1.5">
          <p className="break-words text-xs font-semibold text-gray-700">
            {c.authorName || 'Member'} <span className="font-normal text-gray-400">· {timeAgo(c.createdAt)}</span>
            {c.editedAt && <span className="font-normal text-gray-400" data-testid={`comment-edited-${c.id}`}> · {EDITED_LABEL}</span>}
          </p>
          {editForm ?? <ClampedText text={c.content} kind="comment" className="text-sm text-gray-800" testId={`comment-text-${c.id}`} />}
        </div>
        <div className="-ml-1 flex flex-wrap items-center gap-0.5">
          {canLike ? (
            <button
              type="button" onClick={onLike} aria-pressed={c.likedByMe}
              className={`min-h-[44px] min-w-[44px] px-2 text-xs font-semibold ${c.likedByMe ? 'text-rsn-red' : 'text-gray-500 hover:text-gray-800'}`}
              data-testid={`comment-like-${c.id}`}
            >
              {c.likedByMe ? 'Liked' : 'Like'}{c.likeCount > 0 ? ` · ${c.likeCount}` : ''}
            </button>
          ) : c.likeCount > 0 && (
            <span className="px-2 text-xs text-gray-500" data-testid={`comment-likes-${c.id}`}>
              {c.likeCount} {c.likeCount === 1 ? 'like' : 'likes'}
            </span>
          )}
          {!isReply && viewer.canPost && (
            <button type="button" onClick={onReply} className={textButton} data-testid={`reply-button-${c.id}`}>Reply</button>
          )}
          {config.reportKind && userId && c.authorId !== userId && (
            <ReportCommentButton kind={config.reportKind} commentId={c.id} authorId={c.authorId} authorName={c.authorName} excerpt={c.content} />
          )}
          {canEditWallItem(viewer, c.authorId, userId) && !editForm && (
            <button type="button" onClick={onEdit} className={textButton} data-testid={`comment-edit-${c.id}`}>Edit</button>
          )}
          {canDeleteWallItem(viewer, c.authorId, userId) && (
            <button type="button" onClick={onDelete} aria-label="Delete comment" className={deleteButton} data-testid={`comment-delete-${c.id}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
