// A post's comments, with one level of replies. Loaded when the post's comments are opened.
//
// What the viewer can do depends on two separate things the server decides: whether they may POST (comment,
// reply, like), and whether they may MODERATE (delete anyone's). A pod that is archived takes nothing new, yet
// its moderators still delete and its authors still take back their own words, so Delete is never tied to
// posting. The comment list is the server's: comments by authors the viewer has blocked, and replies under
// them, are already left out, and a list cut at 400 says so.
//
// Shirley pilot S4 (11 Nov 2026): an author edits their own comment or reply in place while they may post, and it then
// says "Edited". The draft is held here, so a comment removed while its edit is open stays on screen as "This comment
// was removed." with the text to copy. Long comments are cut to six lines with "Show more".

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { useConfirm } from '@/hooks/useConfirm';
import WallCommentRow from './WallCommentRow';
import WallEditForm from './WallEditForm';
import { deletedSentence, isConflict, newerStamp, normalizeComments, retryUnlessAnswered, threadOf, wallErrorSentence } from './wall-logic';
import type { WallCommentList, WallComment, WallConfig, WallViewer } from './wall-types';

const inputClass = 'min-h-[44px] min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30';

export default function WallComments({ config, postId, viewer, userId, onChanged }: {
  config: WallConfig;
  postId: string;
  viewer: WallViewer;
  userId: string | undefined;
  onChanged: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const { ask, confirmDialog } = useConfirm();
  const replyRef = useRef<HTMLInputElement>(null);
  // The author's open edit: the comment, the words being written and the stamp it had when the edit opened.
  const [editing, setEditing] = useState<{ comment: WallComment; draft: string; stamp: string | null } | null>(null);

  const thread = useQuery<WallCommentList>({
    queryKey: config.keys.comments(postId),
    queryFn: () => api.get(`${config.itemBase}/posts/${postId}/comments`).then((r) => normalizeComments(r.data.data)),
    retry: retryUnlessAnswered,
    meta: { entities: config.entities.comments(postId) },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: config.keys.comments(postId), exact: true });

  const all = thread.data?.comments ?? [];
  // Past the cap the server shows only the first comments, so a new one would never be seen: the boxes close and say
  // why (P1 item 16).
  const full = !!thread.data?.truncated;
  const { tops, repliesOf } = threadOf(all);
  // Someone who cannot post still sees how many likes a comment has; they just have no button.
  const canLike = viewer.canPost || config.copy.likeNeedsMembership !== undefined;

  const send = async (content: string, parentCommentId?: string) => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await api.post(`${config.itemBase}/posts/${postId}/comments`, parentCommentId ? { content: trimmed, parentCommentId } : { content: trimmed });
      if (parentCommentId) { setReplyDraft(''); setReplyTo(null); } else setDraft('');
      // Never held on the refetch: a slow one would keep the box disabled for seconds.
      void reload();
      onChanged();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not comment.'), 'error');
      // The pod was archived since the page last looked: read the feed again, so this box goes.
      if (isConflict(err)) onChanged();
    } finally {
      setSending(false);
    }
  };

  const like = async (c: WallComment) => {
    if (!viewer.canPost) {
      if (config.copy.likeNeedsMembership) addToast(config.copy.likeNeedsMembership, 'info');
      return;
    }
    try {
      await api.post(`${config.itemBase}/comments/${c.id}/like`, { liked: !c.likedByMe });
      void reload();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not like that.'), 'error');
      if (isConflict(err)) onChanged();
    }
  };

  const remove = async (c: WallComment) => {
    // Fix round 1: the author's own delete keeps other people's replies; a moderator's takes the thread.
    const own = c.authorId === userId;
    const body = own && !c.parentCommentId && repliesOf(c.id).length > 0
      ? 'It will read "This comment was deleted". The replies stay. This cannot be undone.'
      : own || c.parentCommentId ? 'This cannot be undone.' : 'Its replies go with it. This cannot be undone.';
    if (!(await ask({ title: 'Delete this comment?', body, confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      const r = await api.delete(`${config.itemBase}/comments/${c.id}`);
      addToast(deletedSentence('comment', r.data?.data?.alreadyRemoved), 'info');
      if (editing?.comment.id === c.id) setEditing(null);
      void reload();
      onChanged();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not delete.'), 'error');
    }
  };

  // What each of the author's saves wrote and the stamp it answered, so a quick reopen (before the list has refreshed)
  // opens with the version the server has, and is not refused as stale (fix round 1).
  const saved = useRef<Record<string, { content: string; editedAt: string | null }>>({});
  const saveEdit = async (c: WallComment, text: string) => {
    const res = await api.patch(`${config.itemBase}/comments/${c.id}`, { content: text, expectedEditedAt: editing?.stamp ?? null });
    saved.current[c.id] = { content: text, editedAt: (res.data?.data?.editedAt as string | null | undefined) ?? null };
    setEditing(null);
    void reload();
  };

  const openedEdit = (c: WallComment) => {
    const mine = saved.current[c.id];
    const stamp = newerStamp(c.editedAt, mine?.editedAt);
    const fresher = !!mine && stamp === mine.editedAt && stamp !== (c.editedAt ?? null);
    return { comment: c, draft: fresher ? mine.content : c.content, stamp };
  };

  const editForm = (c: WallComment, gone: boolean) => editing && (
    <WallEditForm
      draft={editing.draft}
      onDraft={(draft) => setEditing((cur) => (cur ? { ...cur, draft } : cur))}
      original={c.content}
      maxLength={4000}
      allowEmpty={false}
      gone={gone ? 'This comment was removed.' : undefined}
      label="Edit your comment"
      onSave={(text) => saveEdit(c, text)}
      onCancel={() => setEditing(null)}
      testId={`edit-comment-${c.id}`}
    />
  );
  // A comment whose edit is open but that is no longer in the thread (removed, or its parent was).
  const heldGone = editing && !all.some((c) => c.id === editing.comment.id) ? editing.comment : null;

  const renderComment = (c: WallComment, isReply: boolean): JSX.Element => (
    <WallCommentRow
      key={c.id} config={config} comment={c} isReply={isReply} viewer={viewer} userId={userId} canLike={canLike}
      editForm={editing?.comment.id === c.id ? editForm(c, false) : null}
      onLike={() => void like(c)}
      onReply={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyDraft(''); requestAnimationFrame(() => replyRef.current?.focus()); }}
      onEdit={() => setEditing(openedEdit(c))}
      onDelete={() => void remove(c)}
    >
      {!isReply && repliesOf(c.id).map((r) => renderComment(r, true))}
      {!isReply && replyTo === c.id && (
        <div className="ml-8 flex items-center gap-2" data-testid={`reply-form-${c.id}`}>
          <input
            ref={replyRef}
            value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(replyDraft, c.id); } }}
            placeholder={`Reply to ${c.authorName || 'this comment'}…`}
            maxLength={4000}
            disabled={full}
            aria-label="Your reply"
            className={inputClass}
          />
          <Button size="sm" onClick={() => void send(replyDraft, c.id)} disabled={full || sending || !replyDraft.trim()} className="min-h-[44px] min-w-[44px]" aria-label="Send reply">
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </WallCommentRow>
  );

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-2" data-testid={`comments-${postId}`}>
      {thread.isLoading ? <Spinner /> : thread.isError && !thread.data ? (
        <p className="text-xs text-gray-500">
          {wallErrorSentence(thread.error, 'We could not load the comments just now.')}{' '}
          <button type="button" onClick={() => void thread.refetch()} className="min-h-[44px] px-1 font-semibold text-rsn-red">Try again</button>
        </p>
      ) : tops.map((c) => renderComment(c, false))}
      {heldGone && (
        <div className="rounded-lg bg-gray-50 px-2.5 py-1.5" data-testid={`comment-gone-${heldGone.id}`}>
          {editForm(heldGone, true)}
        </div>
      )}
      {thread.data?.truncated && (
        <p className="text-xs text-gray-400" data-testid={`comments-truncated-${postId}`}>
          {`Showing the first ${all.length} comments. New comments are closed on this post.`}
        </p>
      )}
      {viewer.canPost && (
        <div className="flex items-center gap-2">
          <input
            value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
            placeholder="Write a comment…"
            maxLength={4000}
            disabled={full}
            aria-label="Your comment"
            className={inputClass}
          />
          <Button size="sm" onClick={() => void send(draft)} disabled={full || sending || !draft.trim()} className="min-h-[44px] min-w-[44px]" aria-label="Send comment">
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {!viewer.canPost && !thread.isLoading && all.length === 0 && !thread.isError && (
        <p className="text-xs text-gray-400">No comments yet.</p>
      )}
      {confirmDialog}
    </div>
  );
}
