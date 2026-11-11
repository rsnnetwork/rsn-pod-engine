// A post's row of controls and what they open: react, comment, share (copy the link, or into another circle), and at
// the right edge the author's Edit and the Delete and Pin the viewer may use. Split out of WallPostCard (S4 fix round
// 1), with no change in behaviour.
//
// Two separate questions decide the controls, and the server answers both (viewer.canPost, viewer.canModerate):
// posting (react, comment) and moderating (delete anyone's, pin). An author deletes their own. Neither delete nor pin
// waits on canPost, so an archived pod's moderators can still clear it. A post the viewer can do nothing with draws no
// empty row of controls under a divider. Someone else's post can also be reported from where it is (S5, item 16; a
// moderator sees Report post beside Delete and Pin), never the viewer's own.

import { useState } from 'react';
import { Link2, MessageCircle, Pencil, Pin, Share2, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { useConfirm } from '@/hooks/useConfirm';
import ReportPostButton from './ReportPostButton';
import { ReactButtons, ReactionPicker, type WallReactions } from './WallPostReactions';
import { WALL_ACTION_BUTTON, canDeleteWallItem, canEditWallItem, canPinWallPost, deletedSentence, wallErrorSentence } from './wall-logic';
import type { WallConfig, WallPost, WallViewer } from './wall-types';
import type { PostEdit } from './WallPostCard';

export default function WallPostActions({
  config, post: p, viewer, userId, content, editedAt, edit, onEdit, gone, r, openComments, onToggleComments, onChanged, onRemoved,
}: {
  config: WallConfig;
  post: WallPost;
  viewer: WallViewer;
  userId: string | undefined;
  content: string;
  editedAt: string | null;
  edit: PostEdit | null;
  onEdit: (draft: string | null, stamp?: string | null) => void;
  gone?: boolean;
  r: WallReactions;
  openComments: boolean;
  onToggleComments: () => void;
  onChanged: () => void;
  onRemoved: (postId: string) => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const [shareOpen, setShareOpen] = useState<null | 'menu' | 'target'>(null);
  const { ask, confirmDialog } = useConfirm();

  const mayDelete = canDeleteWallItem(viewer, p.authorId, userId);
  const mayPin = canPinWallPost(viewer);
  const mayEdit = canEditWallItem(viewer, p.authorId, userId);
  // Who cannot post sees the buttons they could never use only where the wall explains instead of hiding.
  const showsReactions = viewer.canPost || config.copy.reactNeedsMembership !== undefined;
  const showsCommentButton = showsReactions || p.commentCount > 0;
  // A post the viewer can do nothing with (an archived pod, someone else's words, no comments) has no row of controls.
  // Someone else's post can be reported from where it is (11 Nov 2026, item 16).
  const mayReport = !!config.reportKind && !!userId && p.authorId !== userId;
  const hasControls = !gone && (showsReactions || showsCommentButton || !!config.share || mayDelete || mayPin || mayEdit || mayReport);

  const del = async () => {
    if (!(await ask({ title: 'Delete this post?', body: 'Its comments go with it. This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      const res = await api.delete(`${config.itemBase}/posts/${p.id}`);
      addToast(deletedSentence('post', res.data?.data?.alreadyRemoved), 'info');
      if (edit) onEdit(null);
      onRemoved(p.id);
      onChanged();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not delete.'), 'error');
    }
  };

  const pin = async () => {
    try {
      await api.post(`${config.itemBase}/posts/${p.id}/${p.pinnedAt ? 'unpin' : 'pin'}`);
      onChanged();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not pin.'), 'error');
    }
  };

  const copyLink = async () => {
    if (!config.share) return;
    const url = `${window.location.origin}${config.share.href(p)}`;
    try {
      await navigator.clipboard.writeText(url);
      addToast('Link copied.', 'success');
    } catch {
      window.prompt('Copy this link', url);
    }
    setShareOpen(null);
  };

  return (
    <>
      {hasControls && (
        <div className="mt-1 -ml-2 flex items-center gap-0.5 flex-wrap border-t border-gray-100 pt-1">
          {showsReactions && <ReactButtons post={p} r={r} />}
          {showsCommentButton && (
            <button type="button" onClick={onToggleComments} aria-expanded={openComments} className={WALL_ACTION_BUTTON} data-testid={`comment-button-${p.id}`}>
              <MessageCircle className="h-3.5 w-3.5" />
              {showsReactions ? 'Comment' : 'Comments'}
            </button>
          )}
          {config.share && (
            <button
              type="button" onClick={() => setShareOpen((v) => (v ? null : 'menu'))}
              className={WALL_ACTION_BUTTON} aria-expanded={!!shareOpen} data-testid={`share-button-${p.id}`}
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </button>
          )}
          {mayReport && config.reportKind && (
            <ReportPostButton
              kind={config.reportKind} postId={p.id} authorId={p.authorId} authorName={p.authorName} excerpt={p.content}
              className={WALL_ACTION_BUTTON}
            />
          )}
          {(mayDelete || mayPin || mayEdit) && (
            // Together, at the right edge: on a 360px phone they wrap onto a line of their own as a group.
            <div className="ml-auto flex items-center gap-0.5">
              {mayEdit && !edit && (
                <button
                  type="button" onClick={() => onEdit(content, editedAt)}
                  className={`${WALL_ACTION_BUTTON} text-gray-400 hover:text-gray-800`}
                  aria-label="Edit post" title="Edit post"
                  data-testid={`edit-post-button-${p.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              {mayDelete && (
                <button type="button" onClick={() => void del()} className={`${WALL_ACTION_BUTTON} text-gray-300 hover:text-red-500`} aria-label="Delete post" title="Delete post" data-testid={`delete-post-${p.id}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              {mayPin && (
                <button
                  type="button" onClick={() => void pin()}
                  className={`${WALL_ACTION_BUTTON} ${p.pinnedAt ? 'text-rsn-red' : 'text-gray-300'}`}
                  aria-label={p.pinnedAt ? 'Unpin post' : 'Pin post'}
                  title={p.pinnedAt ? 'Unpin post' : 'Pin post'}
                  data-testid={`pin-post-${p.id}`}
                >
                  <Pin className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {r.pickerOpen && <ReactionPicker post={p} r={r} />}

      {config.share && shareOpen === 'menu' && (
        <div className="mt-1 flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm" data-testid={`share-menu-${p.id}`}>
          <button type="button" onClick={() => void copyLink()} className={WALL_ACTION_BUTTON} data-testid={`copy-link-${p.id}`}>
            <Link2 className="h-3.5 w-3.5" /> Copy link
          </button>
          {config.share.renderTargetForm && (
            <button type="button" onClick={() => setShareOpen('target')} className={WALL_ACTION_BUTTON} data-testid={`share-to-circle-${p.id}`}>
              <Share2 className="h-3.5 w-3.5" /> Share to a circle
            </button>
          )}
        </div>
      )}
      {config.share?.renderTargetForm && shareOpen === 'target' && config.share.renderTargetForm({ post: p, onDone: () => setShareOpen(null) })}
      {confirmDialog}
    </>
  );
}
