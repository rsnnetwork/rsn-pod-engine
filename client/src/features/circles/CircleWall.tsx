// ─── Circle Wall ─────────────────────────────────────────────────────────────
//
// REASON v1 Phase 4 (20 Jul 2026). The feed inside a circle: text + images +
// external link shares, comments, pinning. Posting is members-only (the
// server enforces it; the UI mirrors it with a join prompt). Media rides the
// existing Cloudinary unsigned-upload path; link cards are rendered from the
// URL alone — the server never fetches external sites.
//
// 4 Sep 2026 (Ali): the wall behaves like a social feed now. Reactions (Like,
// Love, Applause, Insightful, Celebrate; one per member per post), replies one
// level deep, likes on comments, share (copy the link, or post it into another
// circle with attribution to the original), delete on own posts and comments
// (admins any), and a ?post= deep link that scrolls the post into view.
// Phone-first: every control is a 44px target and the reaction picker is a
// row that wraps.

import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Send, ImagePlus, X, Pin, Trash2, MessageCircle, ExternalLink, Loader2,
  Share2, Link2, ThumbsUp, ChevronDown, CornerDownRight,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import Linkify from '@/components/ui/Linkify';
import api from '@/lib/api';
import {
  isCloudinaryConfigured, uploadImageToCloudinary,
} from '@/lib/cloudinary';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { isAdmin } from '@/lib/utils';

export const REACTIONS = [
  { key: 'like', emoji: '👍', label: 'Like' },
  { key: 'love', emoji: '❤️', label: 'Love' },
  { key: 'applause', emoji: '👏', label: 'Applause' },
  { key: 'insightful', emoji: '💡', label: 'Insightful' },
  { key: 'celebrate', emoji: '🎉', label: 'Celebrate' },
] as const;
type ReactionKey = typeof REACTIONS[number]['key'];
const reactionOf = (key: string | null | undefined) => REACTIONS.find(r => r.key === key) ?? null;

interface WallMediaItem { type: 'image' | 'video'; url: string; meta?: Record<string, unknown> | null }
interface SharedFrom {
  id: string; circleId: string; circleName: string; authorName: string | null;
  content: string; media: WallMediaItem[];
}
interface WallPost {
  id: string; circleId: string; authorId: string; authorName: string | null; authorAvatarUrl: string | null;
  content: string; media: WallMediaItem[]; linkUrl: string | null;
  commentCount: number; pinnedAt: string | null; createdAt: string;
  reactionCount: number; reactions: Partial<Record<ReactionKey, number>>; myReaction: ReactionKey | null;
  sharedFrom: SharedFrom | null;
}
interface WallPage { pinned: WallPost[]; posts: WallPost[]; nextCursor: string | null }
interface WallComment {
  id: string; authorId: string; authorName: string | null; authorAvatarUrl: string | null;
  content: string; createdAt: string; parentCommentId: string | null;
  likeCount: number; likedByMe: boolean;
}
interface CircleOption { id: string; name: string; isMember: boolean }

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

const postLink = (circleId: string, postId: string) => `/circles/${circleId}?post=${postId}`;

export default function CircleWall({ circleId, isMember, highlightPostId }: { circleId: string; isMember: boolean; highlightPostId?: string }) {
  const { user } = useAuthStore();
  const admin = isAdmin(user?.role);
  const { addToast } = useToastStore();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState('');
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [pendingImage, setPendingImage] = useState<{ url: string; uploading: boolean } | null>(null);
  const [posting, setPosting] = useState(false);
  const [linkedPost, setLinkedPost] = useState<WallPost | null>(null);

  // realtime: skip — wall refetches on focus + 30s interval per the architecture spec (fan-out-on-read)
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['circleWall', circleId],
    queryFn: ({ pageParam }) =>
      api.get(`/circles/${circleId}/posts${pageParam ? `?cursor=${pageParam}` : ''}`)
        .then(r => r.data.data as WallPage),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['circleWall', circleId] });

  const pinned = data?.pages[0]?.pinned ?? [];
  const posts = data?.pages.flatMap(p => p.posts) ?? [];
  const pinnedIds = new Set(pinned.map(p => p.id));
  const loadedIds = new Set([...pinned, ...posts].map(p => p.id));

  // The ?post= deep link (from a share or a bell entry): scroll it into view
  // when it is on the loaded pages; otherwise fetch it alone and show it on top.
  useEffect(() => {
    if (!highlightPostId || isLoading) return;
    if (loadedIds.has(highlightPostId) || linkedPost?.id === highlightPostId) {
      document.querySelector(`[data-testid="wall-post-${highlightPostId}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    api.get(`/circles/posts/${highlightPostId}`)
      .then(r => setLinkedPost(r.data.data as WallPost))
      .catch(() => addToast('That post is no longer available.', 'info'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightPostId, isLoading, data, linkedPost?.id]);

  const attachImage = async (file: File) => {
    setPendingImage({ url: '', uploading: true });
    try {
      const res = await uploadImageToCloudinary(file);
      setPendingImage({ url: res.url, uploading: false });
    } catch (err: any) {
      setPendingImage(null);
      addToast(err?.message || 'Image upload failed.', 'error');
    }
  };

  const submit = async () => {
    const content = draft.trim();
    if (posting || (!content && !pendingImage?.url)) return;
    setPosting(true);
    try {
      await api.post(`/circles/${circleId}/posts`, {
        clientId,
        content,
        media: pendingImage?.url ? [{ type: 'image', url: pendingImage.url }] : [],
      });
      setDraft(''); setPendingImage(null); setClientId(crypto.randomUUID());
      // Fire-and-forget: holding `posting` through the refetch kept the
      // composer disabled for seconds when a refetch was slow or deduped
      // against the 30s interval (caught by the 20 Jul UI matrix).
      void refresh();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Could not post.', 'error');
    } finally {
      setPosting(false);
    }
  };

  if (isLoading) return <div className="py-6 flex justify-center"><Spinner /></div>;

  const card = (p: WallPost, showPinBadge: boolean, extra?: { linked?: boolean }) => (
    <PostCard
      key={p.id} post={p} showPinBadge={showPinBadge} linked={!!extra?.linked}
      highlighted={p.id === highlightPostId}
      circleId={circleId} isMember={isMember} admin={admin} userId={user?.id}
      onChanged={() => { void refresh(); if (linkedPost?.id === p.id) setLinkedPost(null); }}
    />
  );

  return (
    <div className="space-y-3" data-testid="circle-wall">
      {isMember ? (
        <Card className="!p-4">
          <textarea
            value={draft} onChange={e => setDraft(e.target.value)}
            placeholder="Share something with the circle…"
            maxLength={8000} rows={2}
            className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30 resize-none"
          />
          {pendingImage && (
            <div className="relative inline-block mt-2">
              {pendingImage.uploading
                ? <div className="h-20 w-28 rounded-lg bg-gray-100 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
                : <img src={pendingImage.url} alt="" className="h-20 rounded-lg object-cover" />}
              <button
                onClick={() => setPendingImage(null)}
                className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-gray-800 text-white flex items-center justify-center"
                aria-label="Remove image"
              ><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
          <div className="flex items-center justify-between mt-2">
            {isCloudinaryConfigured() ? (
              <label className="cursor-pointer text-gray-400 hover:text-gray-700 min-h-[44px] min-w-[44px] flex items-center justify-center" title="Add an image">
                <ImagePlus className="h-5 w-5" />
                <input
                  type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) attachImage(f); e.target.value = ''; }}
                />
              </label>
            ) : <span />}
            <Button size="sm" onClick={submit} disabled={posting || pendingImage?.uploading || (!draft.trim() && !pendingImage?.url)} className="min-h-[44px]">
              <Send className="h-4 w-4 mr-1.5" /> {posting ? 'Posting…' : 'Post'}
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="!p-4">
          <p className="text-sm text-gray-500 text-center">Join this circle to post on its wall.</p>
        </Card>
      )}

      {linkedPost && !loadedIds.has(linkedPost.id) && card(linkedPost, !!linkedPost.pinnedAt, { linked: true })}
      {pinned.map(p => card(p, true))}
      {posts.filter(p => !pinnedIds.has(p.id)).map(p => card(p, false))}

      {posts.length === 0 && pinned.length === 0 && !linkedPost && (
        <p className="text-sm text-gray-400 text-center py-4">Nothing here yet — start the conversation.</p>
      )}

      {hasNextPage && (
        <Button variant="ghost" onClick={() => fetchNextPage()} disabled={isFetchingNextPage} className="w-full min-h-[44px]">
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}

// ─── One post ────────────────────────────────────────────────────────────────

function PostCard({ post: p, showPinBadge, linked, highlighted, circleId, isMember, admin, userId, onChanged }: {
  post: WallPost; showPinBadge: boolean; linked: boolean; highlighted: boolean;
  circleId: string; isMember: boolean; admin: boolean; userId?: string; onChanged: () => void;
}) {
  const { addToast } = useToastStore();
  const [openComments, setOpenComments] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState<null | 'menu' | 'circle'>(null);
  const [reacting, setReacting] = useState(false);
  // What the server answered to my last reaction, until the next refetch
  // brings the same numbers back through the post itself.
  const [local, setLocal] = useState<{ reactionCount: number; reactions: WallPost['reactions']; myReaction: ReactionKey | null } | null>(null);
  useEffect(() => { setLocal(null); }, [p.reactionCount, p.myReaction]);

  const reactionCount = local?.reactionCount ?? p.reactionCount ?? 0;
  const reactions = local?.reactions ?? p.reactions ?? {};
  const myReaction = local ? local.myReaction : (p.myReaction ?? null);
  const mine = reactionOf(myReaction);
  const topEmojis = REACTIONS.filter(r => (reactions[r.key] ?? 0) > 0)
    .sort((a, b) => (reactions[b.key] ?? 0) - (reactions[a.key] ?? 0)).slice(0, 3);
  const canModerate = admin || p.authorId === userId;

  const react = async (key: ReactionKey | null) => {
    if (!isMember) { addToast('Join this circle to react.', 'info'); return; }
    if (reacting) return;
    setReacting(true); setPickerOpen(false);
    try {
      const r = await api.post(`/circles/posts/${p.id}/react`, { reaction: key });
      setLocal(r.data.data);
      onChanged();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Could not react.', 'error');
    } finally {
      setReacting(false);
    }
  };

  const del = async () => {
    if (!confirm('Delete this post?')) return;
    try { await api.delete(`/circles/posts/${p.id}`); addToast('Post deleted.', 'info'); onChanged(); }
    catch { addToast('Could not delete.', 'error'); }
  };

  const pin = async () => {
    try {
      await api.post(`/circles/posts/${p.id}/${p.pinnedAt ? 'unpin' : 'pin'}`);
      onChanged();
    } catch { addToast('Could not pin.', 'error'); }
  };

  const copyLink = async () => {
    const url = `${window.location.origin}${postLink(p.circleId || circleId, p.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      addToast('Link copied.', 'success');
    } catch {
      window.prompt('Copy this link', url);
    }
    setShareOpen(null);
  };

  const actionBtn = 'flex items-center gap-1.5 min-h-[44px] px-2 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800';

  return (
    <Card
      className={`!p-4 ${highlighted ? 'ring-2 ring-rsn-red/40' : ''}`}
      data-testid={`wall-post-${p.id}`}
    >
      {linked && (
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400" data-testid="linked-post">Linked post</p>
      )}
      <div className="flex items-start gap-3">
        <Avatar src={p.authorAvatarUrl || undefined} name={p.authorName || 'Member'} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900">{p.authorName || 'Member'}</p>
            <p className="text-[11px] text-gray-400">{timeAgo(p.createdAt)}</p>
            {showPinBadge && p.pinnedAt && (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-rsn-red bg-rsn-red-light px-1.5 py-0.5 rounded-full">
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
              to={postLink(p.sharedFrom.circleId, p.sharedFrom.id)}
              className="mt-2 block rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 hover:bg-gray-100 transition-colors"
              data-testid={`shared-from-${p.id}`}
            >
              <p className="text-[11px] font-semibold text-gray-500 flex items-center gap-1">
                <Share2 className="h-3 w-3" /> Shared from {p.sharedFrom.circleName}
                {p.sharedFrom.authorName ? ` · ${p.sharedFrom.authorName}` : ''}
              </p>
              {p.sharedFrom.content && (
                <p className="mt-1 text-xs text-gray-700 line-clamp-4 whitespace-pre-wrap break-words">{p.sharedFrom.content}</p>
              )}
              {p.sharedFrom.media?.find(m => m.type === 'image') && (
                <img src={p.sharedFrom.media.find(m => m.type === 'image')!.url} alt="" className="mt-2 rounded-md max-h-40 w-auto max-w-full object-contain" loading="lazy" />
              )}
            </Link>
          )}
          {p.media.filter(m => m.type === 'image').map(m => (
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
            <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
              <span data-testid={`reaction-summary-${p.id}`} className="flex items-center gap-1">
                {reactionCount > 0 && (
                  <>
                    <span aria-hidden>{topEmojis.map(r => r.emoji).join('')}</span>
                    <span>{reactionCount}</span>
                  </>
                )}
              </span>
              {p.commentCount > 0 && <span>{p.commentCount} {p.commentCount === 1 ? 'comment' : 'comments'}</span>}
            </div>
          )}

          <div className="mt-1 -ml-2 flex items-center gap-0.5 flex-wrap border-t border-gray-100 pt-1">
            <button
              type="button"
              onClick={() => (mine ? react(null) : react('like'))}
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
              onClick={() => setPickerOpen(v => !v)}
              aria-label="Choose a reaction"
              aria-expanded={pickerOpen}
              className="flex h-11 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700"
              data-testid={`reaction-picker-toggle-${p.id}`}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setOpenComments(v => !v)}
              className={actionBtn}
              data-testid={`comment-button-${p.id}`}
            >
              <MessageCircle className="h-3.5 w-3.5" />
              Comment
            </button>
            <button
              type="button"
              onClick={() => setShareOpen(v => (v ? null : 'menu'))}
              className={actionBtn}
              aria-expanded={!!shareOpen}
              data-testid={`share-button-${p.id}`}
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </button>
            {canModerate && (
              <button type="button" onClick={del} className={`${actionBtn} text-gray-300 hover:text-red-500`} aria-label="Delete post" data-testid={`delete-post-${p.id}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            {admin && (
              <button type="button" onClick={pin} className={`${actionBtn} ${p.pinnedAt ? 'text-rsn-red' : 'text-gray-300'}`} aria-label={p.pinnedAt ? 'Unpin post' : 'Pin post'}>
                <Pin className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {pickerOpen && (
            <div
              role="group" aria-label="Choose a reaction"
              className="mt-1 flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm"
              data-testid={`reaction-picker-${p.id}`}
            >
              {REACTIONS.map(r => (
                <button
                  key={r.key} type="button"
                  onClick={() => react(myReaction === r.key ? null : r.key)}
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

          {shareOpen === 'menu' && (
            <div className="mt-1 flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm" data-testid={`share-menu-${p.id}`}>
              <button type="button" onClick={copyLink} className={actionBtn} data-testid={`copy-link-${p.id}`}>
                <Link2 className="h-3.5 w-3.5" /> Copy link
              </button>
              <button type="button" onClick={() => setShareOpen('circle')} className={actionBtn} data-testid={`share-to-circle-${p.id}`}>
                <Share2 className="h-3.5 w-3.5" /> Share to a circle
              </button>
            </div>
          )}
          {shareOpen === 'circle' && (
            <ShareToCircle post={p} currentCircleId={circleId} onDone={() => setShareOpen(null)} />
          )}

          {openComments && (
            <PostComments postId={p.id} isMember={isMember} admin={admin} userId={userId} onChanged={onChanged} />
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── Share into another circle ───────────────────────────────────────────────

function ShareToCircle({ post, currentCircleId, onDone }: { post: WallPost; currentCircleId: string; onDone: () => void }) {
  const { addToast } = useToastStore();
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [clientId] = useState(() => crypto.randomUUID());

  // realtime: skip — a one-off picker; the circle list changes rarely and refetches on focus
  const { data: circles, isLoading } = useQuery<CircleOption[]>({
    queryKey: ['circles', 'share-picker'],
    queryFn: () => api.get('/circles').then(r => (r.data.data ?? []) as CircleOption[]),
    staleTime: 60_000,
  });
  const options = (circles ?? []).filter(c => c.isMember && c.id !== currentCircleId);

  const share = async () => {
    if (!target || sending) return;
    setSending(true);
    try {
      await api.post(`/circles/posts/${post.id}/share`, { circleId: target, clientId, content: note.trim() });
      const name = options.find(c => c.id === target)?.name || 'the circle';
      addToast(`Shared to ${name}.`, 'success');
      onDone();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Could not share.', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3 space-y-2" data-testid={`share-form-${post.id}`}>
      {isLoading ? <Spinner /> : options.length === 0 ? (
        <p className="text-xs text-gray-500">You are not in any other circle yet.</p>
      ) : (
        <>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-400">Share to</label>
          <select
            value={target} onChange={e => setTarget(e.target.value)}
            aria-label="Circle to share to"
            className="w-full min-h-[44px] rounded-lg border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30"
          >
            <option value="">Choose a circle…</option>
            {options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <textarea
            value={note} onChange={e => setNote(e.target.value)}
            placeholder="Say something about it (optional)"
            maxLength={2000} rows={2}
            aria-label="Your note"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30 resize-none"
          />
        </>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} className="min-h-[44px]">Cancel</Button>
        {options.length > 0 && (
          <Button size="sm" onClick={share} disabled={!target || sending} className="min-h-[44px]" data-testid={`share-submit-${post.id}`}>
            <Share2 className="h-3.5 w-3.5 mr-1.5" /> {sending ? 'Sharing…' : 'Share'}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Comments, one level of replies ──────────────────────────────────────────

function PostComments({ postId, isMember, admin, userId, onChanged }: {
  postId: string; isMember: boolean; admin: boolean; userId?: string; onChanged: () => void;
}) {
  const { addToast } = useToastStore();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const replyRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // realtime: skip — comments load on expand and refetch after own submits; low-volume v1
  const { data: comments, isLoading } = useQuery<WallComment[]>({
    queryKey: ['wallComments', postId],
    queryFn: () => api.get(`/circles/posts/${postId}/comments`).then(r => r.data.data ?? []),
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ['wallComments', postId] });

  const send = async (content: string, parentCommentId?: string) => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await api.post(`/circles/posts/${postId}/comments`, parentCommentId ? { content: trimmed, parentCommentId } : { content: trimmed });
      if (parentCommentId) { setReplyDraft(''); setReplyTo(null); } else setDraft('');
      // Same fire-and-forget rule as the composer: never hold the input
      // disabled on a refetch.
      void reload();
      onChanged();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Could not comment.', 'error');
    } finally {
      setSending(false);
    }
  };

  const like = async (c: WallComment) => {
    if (!isMember) { addToast('Join this circle to like comments.', 'info'); return; }
    try {
      await api.post(`/circles/comments/${c.id}/like`, { liked: !c.likedByMe });
      void reload();
    } catch { addToast('Could not like that.', 'error'); }
  };

  const remove = async (c: WallComment) => {
    if (!confirm('Delete this comment?')) return;
    try {
      await api.delete(`/circles/comments/${c.id}`);
      void reload();
      onChanged();
    } catch { addToast('Could not delete.', 'error'); }
  };

  const all = comments ?? [];
  const tops = all.filter(c => !c.parentCommentId);
  const repliesOf = (id: string) => all.filter(c => c.parentCommentId === id);

  const renderComment = (c: WallComment, isReply: boolean) => (
    <div key={c.id} className={`flex items-start gap-2 ${isReply ? 'ml-8' : ''}`} data-testid={`comment-${c.id}`}>
      {isReply && <CornerDownRight className="mt-2 h-3 w-3 shrink-0 text-gray-300" aria-hidden />}
      <Avatar src={c.authorAvatarUrl || undefined} name={c.authorName || 'Member'} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="bg-gray-50 rounded-lg px-2.5 py-1.5">
          <p className="text-[11px] font-semibold text-gray-700">
            {c.authorName || 'Member'} <span className="font-normal text-gray-400">· {timeAgo(c.createdAt)}</span>
          </p>
          <p className="text-xs text-gray-800 whitespace-pre-wrap break-words">
            <Linkify text={c.content} />
          </p>
        </div>
        <div className="-ml-1 flex items-center gap-0.5 flex-wrap">
          <button
            type="button" onClick={() => like(c)}
            aria-pressed={c.likedByMe}
            className={`min-h-[44px] px-2 text-[11px] font-semibold ${c.likedByMe ? 'text-rsn-red' : 'text-gray-500 hover:text-gray-800'}`}
            data-testid={`comment-like-${c.id}`}
          >
            {c.likedByMe ? 'Liked' : 'Like'}{c.likeCount > 0 ? ` · ${c.likeCount}` : ''}
          </button>
          {!isReply && isMember && (
            <button
              type="button"
              onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyDraft(''); requestAnimationFrame(() => replyRef.current?.focus()); }}
              className="min-h-[44px] px-2 text-[11px] font-semibold text-gray-500 hover:text-gray-800"
              data-testid={`reply-button-${c.id}`}
            >
              Reply
            </button>
          )}
          {(admin || c.authorId === userId) && (
            <button
              type="button" onClick={() => remove(c)}
              aria-label="Delete comment"
              className="min-h-[44px] px-2 text-gray-300 hover:text-red-500"
              data-testid={`comment-delete-${c.id}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {!isReply && repliesOf(c.id).map(r => renderComment(r, true))}
        {!isReply && replyTo === c.id && (
          <div className="ml-8 flex items-center gap-2" data-testid={`reply-form-${c.id}`}>
            <input
              ref={replyRef}
              value={replyDraft} onChange={e => setReplyDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(replyDraft, c.id); } }}
              placeholder={`Reply to ${c.authorName || 'this comment'}…`}
              maxLength={4000}
              aria-label="Your reply"
              className="flex-1 min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-rsn-red/30 min-h-[44px]"
            />
            <Button size="sm" onClick={() => send(replyDraft, c.id)} disabled={sending || !replyDraft.trim()} className="min-h-[44px]" aria-label="Send reply">
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-2" data-testid={`comments-${postId}`}>
      {isLoading ? <Spinner /> : tops.map(c => renderComment(c, false))}
      {isMember && (
        <div className="flex items-center gap-2">
          <input
            value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); } }}
            placeholder="Write a comment…"
            maxLength={4000}
            aria-label="Your comment"
            className="flex-1 min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-rsn-red/30 min-h-[44px]"
          />
          <Button size="sm" onClick={() => send(draft)} disabled={sending || !draft.trim()} className="min-h-[44px]" aria-label="Send comment">
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
