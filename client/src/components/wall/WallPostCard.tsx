// One post on a wall: who wrote it, what they said, its reactions, and the controls the viewer is allowed.
//
// Two separate questions decide the controls, and the server answers both (viewer.canPost, viewer.canModerate):
//   * posting (like, react, comment): an active member of a pod that is open. A pod that is archived, suspended
//     or still a draft takes nothing new from anyone, so those buttons are not drawn there (the circle wall
//     keeps drawing them and says "join" when tapped, because a circle's non-member can join).
//   * moderating: a moderator deletes anyone's post and pins; an author deletes their own. Neither is switched
//     off by the pod's state, so Delete and Pin never wait on canPost.
//
// A change that changed nothing (the same reaction again, a pin of a pinned post) is answered 200 and tells
// no screen, the acting one included, so every action here applies the answer it got and refreshes the feed
// when it settles (onChanged) instead of waiting for an echo.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, Link2, MessageCircle, Pin, Share2, ThumbsUp, Trash2 } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import Card from '@/components/ui/Card';
import Linkify from '@/components/ui/Linkify';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import WallComments from './WallComments';
import { REACTIONS, canDeleteWallItem, canPinWallPost, domainOf, isConflict, reactionOf, timeAgo, wallErrorSentence } from './wall-logic';
import type { ReactionKey, WallConfig, WallPost, WallViewer } from './wall-types';

const actionBtn = 'flex items-center gap-1.5 min-h-[44px] px-2 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800';

export default function WallPostCard({ config, post: p, viewer, userId, showPinBadge, linked, highlighted, onChanged, onRemoved }: {
  config: WallConfig;
  post: WallPost;
  viewer: WallViewer;
  userId: string | undefined;
  showPinBadge: boolean;
  /** Shown on its own above the feed because the link named a post that is not on the pages loaded so far. */
  linked: boolean;
  highlighted: boolean;
  onChanged: () => void;
  onRemoved: (postId: string) => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const root = useRef<HTMLDivElement>(null);
  const [openComments, setOpenComments] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState<null | 'menu' | 'target'>(null);
  const [reacting, setReacting] = useState(false);
  // What the server answered to my last reaction, until the post itself brings the same numbers back.
  const [local, setLocal] = useState<{ reactionCount: number; reactions: WallPost['reactions']; myReaction: ReactionKey | null } | null>(null);
  const reactionsSeen = `${p.reactionCount}|${p.myReaction}|${JSON.stringify(p.reactions)}`;
  useEffect(() => { setLocal(null); }, [reactionsSeen]);

  // A link that names this post (a bell, a shared address) brings it into view, once per link, and opens its
  // comments if it has any and the wall wants that (the bell said someone commented). Once per link: the wall
  // refetches whenever anything in the pod changes, and the page must not jump back to this post each time.
  const arrived = useRef(false);
  useEffect(() => {
    if (!highlighted) { arrived.current = false; return; }
    if (arrived.current) return;
    arrived.current = true;
    root.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (config.openCommentsOnLink && p.commentCount > 0) setOpenComments(true);
  }, [highlighted, config.openCommentsOnLink, p.commentCount]);

  const reactionCount = local?.reactionCount ?? p.reactionCount ?? 0;
  const reactions = local?.reactions ?? p.reactions ?? {};
  const myReaction = local ? local.myReaction : (p.myReaction ?? null);
  const mine = reactionOf(myReaction);
  const topEmojis = REACTIONS.filter((r) => (reactions[r.key] ?? 0) > 0)
    .sort((a, b) => (reactions[b.key] ?? 0) - (reactions[a.key] ?? 0)).slice(0, 3);

  const mayDelete = canDeleteWallItem(viewer, p.authorId, userId);
  const mayPin = canPinWallPost(viewer);
  // Who cannot post sees the buttons they could never use only where the wall explains instead of hiding.
  const showsReactions = viewer.canPost || config.copy.reactNeedsMembership !== undefined;
  const showsCommentButton = showsReactions || p.commentCount > 0;
  // A post the viewer can do nothing with (an archived pod, someone else's words, no comments) has no row of controls.
  const hasControls = showsReactions || showsCommentButton || !!config.share || mayDelete || mayPin;
  const authorHref = !p.authorClosed && config.authorHref ? config.authorHref(p.authorId) : null;

  const react = async (key: ReactionKey | null) => {
    if (!viewer.canPost) {
      if (config.copy.reactNeedsMembership) addToast(config.copy.reactNeedsMembership, 'info');
      return;
    }
    if (reacting) return;
    setReacting(true); setPickerOpen(false);
    try {
      const r = await api.post(`${config.itemBase}/posts/${p.id}/react`, { reaction: key });
      setLocal(r.data.data);
      onChanged();
    } catch (err) {
      addToast(wallErrorSentence(err, 'Could not react.'), 'error');
      // The pod was archived since the page last looked: read the feed again, so these buttons go.
      if (isConflict(err)) onChanged();
    } finally {
      setReacting(false);
    }
  };

  const del = async () => {
    if (!confirm('Delete this post?')) return;
    try {
      await api.delete(`${config.itemBase}/posts/${p.id}`);
      addToast('Post deleted.', 'info');
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

  const authorName = <p className="min-w-0 break-words text-sm font-semibold text-gray-900">{p.authorName || 'Member'}</p>;
  const avatar = <Avatar src={p.authorAvatarUrl || undefined} name={p.authorName || 'Member'} size="sm" />;
  const sharedImage = p.sharedFrom?.media?.find((m) => m.type === 'image');

  return (
    <div ref={root} className="scroll-mt-4">
      <Card
        className={`!p-4 ${highlighted ? 'ring-2 ring-rsn-red/40' : ''}`}
        data-testid={`wall-post-${p.id}`}
      >
        {linked && (
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400" data-testid="linked-post">Linked post</p>
        )}
        <div className="flex items-start gap-3">
          {authorHref ? (
            // A 44px target around the 32px picture; the negative margin keeps the row where it was.
            <Link to={authorHref} className="-m-1.5 flex h-11 w-11 shrink-0 items-center justify-center" aria-label={`${p.authorName || 'Member'}'s profile`}>
              {avatar}
            </Link>
          ) : avatar}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {authorHref ? <Link to={authorHref} className="min-w-0 hover:underline">{authorName}</Link> : authorName}
              <p className="text-[11px] text-gray-400">{timeAgo(p.createdAt)}</p>
              {showPinBadge && p.pinnedAt && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-rsn-red bg-rsn-red-light px-1.5 py-0.5 rounded-full" data-testid={`pinned-badge-${p.id}`}>
                  <Pin className="h-2.5 w-2.5" /> Pinned
                </span>
              )}
            </div>
            {p.content && (
              <p className="text-sm text-gray-800 mt-1 whitespace-pre-wrap break-words">
                <Linkify text={p.content} />
              </p>
            )}
            {p.sharedFrom && (
              <Link
                to={`/circles/${p.sharedFrom.circleId}?post=${p.sharedFrom.id}`}
                className="mt-2 block rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 hover:bg-gray-100 transition-colors"
                data-testid={`shared-from-${p.id}`}
              >
                <p className="text-xs font-semibold text-gray-500 flex items-center gap-1">
                  <Share2 className="h-3 w-3" /> Shared from {p.sharedFrom.circleName}
                  {p.sharedFrom.authorName ? ` · ${p.sharedFrom.authorName}` : ''}
                </p>
                {p.sharedFrom.content && (
                  <p className="mt-1 text-xs text-gray-700 line-clamp-4 whitespace-pre-wrap break-words">{p.sharedFrom.content}</p>
                )}
                {sharedImage && (
                  <img src={sharedImage.url} alt="" className="mt-2 rounded-md max-h-40 w-auto max-w-full object-contain" loading="lazy" />
                )}
              </Link>
            )}
            {p.media.filter((m) => m.type === 'image').map((m) => (
              <img
                key={m.url} src={m.url} alt=""
                className="mt-2 rounded-lg max-h-80 w-auto max-w-full object-contain bg-gray-50"
                loading="lazy"
              />
            ))}
            {p.linkUrl && (
              <a
                href={p.linkUrl} target="_blank" rel="noopener noreferrer"
                className="mt-2 flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors min-h-[44px]"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="font-medium">{domainOf(p.linkUrl)}</span>
                <span className="truncate text-gray-400">{p.linkUrl}</span>
              </a>
            )}

            {(reactionCount > 0 || p.commentCount > 0) && (
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span data-testid={`reaction-summary-${p.id}`} className="flex items-center gap-1">
                  {reactionCount > 0 && (
                    <>
                      <span aria-hidden>{topEmojis.map((r) => r.emoji).join('')}</span>
                      <span>{reactionCount}</span>
                    </>
                  )}
                </span>
                {p.commentCount > 0 && <span>{p.commentCount} {p.commentCount === 1 ? 'comment' : 'comments'}</span>}
              </div>
            )}

            {hasControls && (
              <div className="mt-1 -ml-2 flex items-center gap-0.5 flex-wrap border-t border-gray-100 pt-1">
                {showsReactions && (
                  <>
                    <button
                      type="button"
                      onClick={() => void (mine ? react(null) : react('like'))}
                      disabled={reacting}
                      aria-pressed={!!mine}
                      aria-label={mine ? `Remove your ${mine.label} reaction` : 'Like'}
                      className={`${actionBtn} ${mine ? 'text-rsn-red' : ''}`}
                      data-testid={`react-button-${p.id}`}
                    >
                      {mine ? <span aria-hidden>{mine.emoji}</span> : <ThumbsUp className="h-3.5 w-3.5" />}
                      {mine ? mine.label : 'Like'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPickerOpen((v) => !v)}
                      aria-label="Choose a reaction"
                      aria-expanded={pickerOpen}
                      className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                      data-testid={`reaction-picker-toggle-${p.id}`}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
                {showsCommentButton && (
                  <button
                    type="button"
                    onClick={() => setOpenComments((v) => !v)}
                    aria-expanded={openComments}
                    className={actionBtn}
                    data-testid={`comment-button-${p.id}`}
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    {showsReactions ? 'Comment' : 'Comments'}
                  </button>
                )}
                {config.share && (
                  <button
                    type="button"
                    onClick={() => setShareOpen((v) => (v ? null : 'menu'))}
                    className={actionBtn}
                    aria-expanded={!!shareOpen}
                    data-testid={`share-button-${p.id}`}
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    Share
                  </button>
                )}
                {(mayDelete || mayPin) && (
                  // Together, at the right edge: on a 360px phone they wrap onto a line of their own as a pair.
                  <div className="ml-auto flex items-center gap-0.5">
                    {mayDelete && (
                      <button type="button" onClick={() => void del()} className={`${actionBtn} text-gray-300 hover:text-red-500`} aria-label="Delete post" data-testid={`delete-post-${p.id}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {mayPin && (
                      <button
                        type="button" onClick={() => void pin()}
                        className={`${actionBtn} ${p.pinnedAt ? 'text-rsn-red' : 'text-gray-300'}`}
                        aria-label={p.pinnedAt ? 'Unpin post' : 'Pin post'}
                        data-testid={`pin-post-${p.id}`}
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {pickerOpen && (
              <div
                role="group" aria-label="Choose a reaction"
                className="mt-1 flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm"
                data-testid={`reaction-picker-${p.id}`}
              >
                {REACTIONS.map((r) => (
                  <button
                    key={r.key} type="button"
                    onClick={() => void react(myReaction === r.key ? null : r.key)}
                    aria-label={`React: ${r.label}`}
                    aria-pressed={myReaction === r.key}
                    className={`flex min-h-[44px] min-w-[44px] items-center gap-1 rounded-lg px-2 text-xs hover:bg-gray-50 ${myReaction === r.key ? 'bg-rsn-red-light text-rsn-red' : 'text-gray-700'}`}
                  >
                    <span className="text-lg" aria-hidden>{r.emoji}</span>
                    <span className="hidden sm:inline">{r.label}</span>
                  </button>
                ))}
              </div>
            )}

            {config.share && shareOpen === 'menu' && (
              <div className="mt-1 flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm" data-testid={`share-menu-${p.id}`}>
                <button type="button" onClick={() => void copyLink()} className={actionBtn} data-testid={`copy-link-${p.id}`}>
                  <Link2 className="h-3.5 w-3.5" /> Copy link
                </button>
                {config.share.renderTargetForm && (
                  <button type="button" onClick={() => setShareOpen('target')} className={actionBtn} data-testid={`share-to-circle-${p.id}`}>
                    <Share2 className="h-3.5 w-3.5" /> Share to a circle
                  </button>
                )}
              </div>
            )}
            {config.share?.renderTargetForm && shareOpen === 'target' && config.share.renderTargetForm({ post: p, onDone: () => setShareOpen(null) })}

            {openComments && (
              <WallComments config={config} postId={p.id} viewer={viewer} userId={userId} onChanged={onChanged} />
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
