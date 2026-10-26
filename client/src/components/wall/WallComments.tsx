// A post's comments, with one level of replies. Loaded when the post's comments are opened.
//
// What the viewer can do depends on two separate things the server decides: whether they may POST (comment,
// reply, like), and whether they may MODERATE (delete anyone's). A pod that is archived takes nothing new, yet
// its moderators still delete and its authors still take back their own words, so Delete is never tied to
// posting. The comment list is the server's: comments by authors the viewer has blocked, and replies under
// them, are already left out, and a list cut at 400 says so.

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CornerDownRight, Send, Trash2 } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import Linkify from '@/components/ui/Linkify';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { canDeleteWallItem, isConflict, normalizeComments, retryUnlessAnswered, threadOf, timeAgo, wallErrorSentence } from './wall-logic';
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
  const replyRef = useRef<HTMLInputElement>(null);

  const thread = useQuery<WallCommentList>({
    queryKey: config.keys.comments(postId),
    queryFn: () => api.get(`${config.itemBase}/posts/${postId}/comments`).then((r) => normalizeComments(r.data.data)),
    retry: retryUnlessAnswered,
    meta: { entities: config.entities.comments(postId) },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: config.keys.comments(postId), exact: true });

  const all = thread.data?.comments ?? [];
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
    if (!confirm('Delete this comment?')) return;
    try {
      await api.delete(`${config.itemBase}/comments/${c.id}`);
      void reload();
      onChanged();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not delete.'), 'error');
    }
  };

  const renderComment = (c: WallComment, isReply: boolean) => {
    const href = !c.authorClosed && config.authorHref ? config.authorHref(c.authorId) : null;
    const avatar = <Avatar src={c.authorAvatarUrl || undefined} name={c.authorName || 'Member'} size="sm" />;
    return (
      <div key={c.id} className={`flex items-start gap-2 ${isReply ? 'ml-8' : ''}`} data-testid={`comment-${c.id}`}>
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
            </p>
            <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
              <Linkify text={c.content} />
            </p>
          </div>
          <div className="-ml-1 flex flex-wrap items-center gap-0.5">
            {canLike ? (
              <button
                type="button" onClick={() => void like(c)}
                aria-pressed={c.likedByMe}
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
              <button
                type="button"
                onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyDraft(''); requestAnimationFrame(() => replyRef.current?.focus()); }}
                className="min-h-[44px] min-w-[44px] px-2 text-xs font-semibold text-gray-500 hover:text-gray-800"
                data-testid={`reply-button-${c.id}`}
              >
                Reply
              </button>
            )}
            {canDeleteWallItem(viewer, c.authorId, userId) && (
              <button
                type="button" onClick={() => void remove(c)}
                aria-label="Delete comment"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center px-2 text-gray-300 hover:text-red-500"
                data-testid={`comment-delete-${c.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {!isReply && repliesOf(c.id).map((r) => renderComment(r, true))}
          {!isReply && replyTo === c.id && (
            <div className="ml-8 flex items-center gap-2" data-testid={`reply-form-${c.id}`}>
              <input
                ref={replyRef}
                value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(replyDraft, c.id); } }}
                placeholder={`Reply to ${c.authorName || 'this comment'}…`}
                maxLength={4000}
                aria-label="Your reply"
                className={inputClass}
              />
              <Button size="sm" onClick={() => void send(replyDraft, c.id)} disabled={sending || !replyDraft.trim()} className="min-h-[44px] min-w-[44px]" aria-label="Send reply">
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-2" data-testid={`comments-${postId}`}>
      {thread.isLoading ? <Spinner /> : thread.isError && !thread.data ? (
        <p className="text-xs text-gray-500">
          {wallErrorSentence(thread.error, 'We could not load the comments just now.')}{' '}
          <button type="button" onClick={() => void thread.refetch()} className="min-h-[44px] px-1 font-semibold text-rsn-red">Try again</button>
        </p>
      ) : tops.map((c) => renderComment(c, false))}
      {thread.data?.truncated && (
        <p className="text-xs text-gray-400" data-testid={`comments-truncated-${postId}`}>
          {`Showing the first ${all.length} comments.`}
        </p>
      )}
      {viewer.canPost && (
        <div className="flex items-center gap-2">
          <input
            value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
            placeholder="Write a comment…"
            maxLength={4000}
            aria-label="Your comment"
            className={inputClass}
          />
          <Button size="sm" onClick={() => void send(draft)} disabled={sending || !draft.trim()} className="min-h-[44px] min-w-[44px]" aria-label="Send comment">
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {!viewer.canPost && !thread.isLoading && all.length === 0 && !thread.isError && (
        <p className="text-xs text-gray-400">No comments yet.</p>
      )}
    </div>
  );
}
