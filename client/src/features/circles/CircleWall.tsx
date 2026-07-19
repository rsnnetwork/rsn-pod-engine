// ─── Circle Wall ─────────────────────────────────────────────────────────────
//
// REASON v1 Phase 4 (20 Jul 2026). The feed inside a circle: text + images +
// external link shares, comments, pinning. Posting is members-only (the
// server enforces it; the UI mirrors it with a join prompt). Media rides the
// existing Cloudinary unsigned-upload path; link cards are rendered from the
// URL alone — the server never fetches external sites.

import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Send, ImagePlus, X, Pin, Trash2, MessageCircle, ExternalLink, Loader2,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import {
  isCloudinaryConfigured, uploadImageToCloudinary,
} from '@/lib/cloudinary';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { isAdmin } from '@/lib/utils';

interface WallMediaItem { type: 'image' | 'video'; url: string; meta?: Record<string, unknown> | null }
interface WallPost {
  id: string; authorId: string; authorName: string | null; authorAvatarUrl: string | null;
  content: string; media: WallMediaItem[]; linkUrl: string | null;
  commentCount: number; pinnedAt: string | null; createdAt: string;
}
interface WallPage { pinned: WallPost[]; posts: WallPost[]; nextCursor: string | null }
interface WallComment {
  id: string; authorId: string; authorName: string | null; authorAvatarUrl: string | null;
  content: string; createdAt: string;
}

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

export default function CircleWall({ circleId, isMember }: { circleId: string; isMember: boolean }) {
  const { user } = useAuthStore();
  const admin = isAdmin(user?.role);
  const { addToast } = useToastStore();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState('');
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [pendingImage, setPendingImage] = useState<{ url: string; uploading: boolean } | null>(null);
  const [posting, setPosting] = useState(false);
  const [openComments, setOpenComments] = useState<string | null>(null);

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

  const del = async (postId: string) => {
    if (!confirm('Delete this post?')) return;
    try { await api.delete(`/circles/posts/${postId}`); await refresh(); }
    catch { addToast('Could not delete.', 'error'); }
  };

  const pin = async (post: WallPost) => {
    try {
      await api.post(`/circles/posts/${post.id}/${post.pinnedAt ? 'unpin' : 'pin'}`);
      await refresh();
    } catch { addToast('Could not pin.', 'error'); }
  };

  if (isLoading) return <div className="py-6 flex justify-center"><Spinner /></div>;

  const pinned = data?.pages[0]?.pinned ?? [];
  const posts = data?.pages.flatMap(p => p.posts) ?? [];
  const pinnedIds = new Set(pinned.map(p => p.id));

  const renderPost = (p: WallPost, showPinBadge: boolean) => (
    <Card key={p.id} className="!p-4" data-testid={`wall-post-${p.id}`}>
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
            <p className="text-sm text-gray-800 mt-1 whitespace-pre-wrap break-words">{p.content}</p>
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
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={() => setOpenComments(openComments === p.id ? null : p.id)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 min-h-[36px]"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              {p.commentCount > 0 ? p.commentCount : 'Comment'}
            </button>
            {(admin || p.authorId === user?.id) && (
              <button onClick={() => del(p.id)} className="text-gray-300 hover:text-red-500 min-h-[36px]" title="Delete">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            {admin && (
              <button onClick={() => pin(p)} className={`min-h-[36px] ${p.pinnedAt ? 'text-rsn-red' : 'text-gray-300 hover:text-gray-600'}`} title={p.pinnedAt ? 'Unpin' : 'Pin'}>
                <Pin className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {openComments === p.id && (
            <PostComments postId={p.id} isMember={isMember} onCommented={refresh} />
          )}
        </div>
      </div>
    </Card>
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

      {pinned.map(p => renderPost(p, true))}
      {posts.filter(p => !pinnedIds.has(p.id)).map(p => renderPost(p, false))}

      {posts.length === 0 && pinned.length === 0 && (
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

function PostComments({ postId, isMember, onCommented }: { postId: string; isMember: boolean; onCommented: () => void }) {
  const { addToast } = useToastStore();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const queryClient = useQueryClient();

  // realtime: skip — comments load on expand and refetch after own submits; low-volume v1
  const { data: comments, isLoading } = useQuery<WallComment[]>({
    queryKey: ['wallComments', postId],
    queryFn: () => api.get(`/circles/posts/${postId}/comments`).then(r => r.data.data ?? []),
  });

  const submit = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await api.post(`/circles/posts/${postId}/comments`, { content });
      setDraft('');
      // Same fire-and-forget rule as the composer: never hold the input
      // disabled on a refetch.
      void queryClient.invalidateQueries({ queryKey: ['wallComments', postId] });
      onCommented();
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Could not comment.', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
      {isLoading ? <Spinner /> : (comments ?? []).map(c => (
        <div key={c.id} className="flex items-start gap-2">
          <Avatar src={c.authorAvatarUrl || undefined} name={c.authorName || 'Member'} size="sm" />
          <div className="min-w-0 bg-gray-50 rounded-lg px-2.5 py-1.5 flex-1">
            <p className="text-[11px] font-semibold text-gray-700">
              {c.authorName || 'Member'} <span className="font-normal text-gray-400">· {timeAgo(c.createdAt)}</span>
            </p>
            <p className="text-xs text-gray-800 whitespace-pre-wrap break-words">{c.content}</p>
          </div>
        </div>
      ))}
      {isMember && (
        <div className="flex items-center gap-2">
          <input
            value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="Write a comment…"
            maxLength={4000}
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-rsn-red/30 min-h-[40px]"
          />
          <Button size="sm" onClick={submit} disabled={sending || !draft.trim()} className="min-h-[40px]">
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
