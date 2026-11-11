// One post on a wall: who wrote it, what they said (WallPostBody), its reactions (WallPostReactions), the controls the
// viewer is allowed (WallPostActions) and its comments.
//
// A change that changed nothing (the same reaction again, a pin of a pinned post) is answered 200 and tells
// no screen, the acting one included, so every action here applies the answer it got and refreshes the feed
// when it settles (onChanged) instead of waiting for an echo.
//
// Shirley pilot S4 (11 Nov 2026): the author edits their own words in place (Edit, beside Delete), and the post
// then says "Edited"; the draft is held by the wall, so it survives the card being drawn again, and the post being
// removed while it is open (`gone`). Long words are cut to ten lines with "Show more" (ClampedText). A link that
// names the post opens it in full, with its comments and the box to write one. A delete that someone else made a
// moment before says "Already removed." S4 fix round 1: the card was split into the pieces above, with no change in
// what it draws or does.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pin } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import Card from '@/components/ui/Card';
import api from '@/lib/api';
import WallComments from './WallComments';
import WallPostActions from './WallPostActions';
import WallPostBody from './WallPostBody';
import { ReactionSummaryRow, useWallReactions } from './WallPostReactions';
import { EDITED_LABEL, timeAgo } from './wall-logic';
import type { WallConfig, WallPost, WallViewer } from './wall-types';

/** The author's edit of this post, held by the wall: the words being written, and the stamp the post had when it opened. */
export interface PostEdit {
  draft: string;
  stamp: string | null;
}

export default function WallPostCard({
  config, post: p, viewer, userId, showPinBadge, linked, highlighted, onChanged, onRemoved, edit, onEdit, gone,
}: {
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
  /** This post's edit, when its author has one open. */
  edit: PostEdit | null;
  /** Open the edit with these words (and the stamp the post has now), change them, or (null) close it. */
  onEdit: (draft: string | null, stamp?: string | null) => void;
  /** The post was removed while its author's edit was open: the edit stays, to be copied, and nothing else is drawn. */
  gone?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [openComments, setOpenComments] = useState(false);
  const r = useWallReactions(p, viewer, config, onChanged);

  // A link that names this post (a bell, a shared address) brings it into view, once per link, and opens its comments
  // if the wall wants that. Once per link: the wall refetches whenever anything changes, and the page must not jump back
  // to this post each time.
  const arrived = useRef(false);
  useEffect(() => {
    if (!highlighted) { arrived.current = false; return; }
    if (arrived.current) return;
    arrived.current = true;
    root.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
    // S4: the comments open whether or not there are any yet, so a bell about a new post lands where a reply is written.
    if (config.openCommentsOnLink) setOpenComments(true);
  }, [highlighted, config.openCommentsOnLink]);

  // What the author just saved, until the post itself brings the same words back from the server.
  const [saved, setSaved] = useState<{ content: string; editedAt: string | null } | null>(null);
  useEffect(() => { setSaved(null); }, [p.content, p.editedAt]);
  const content = saved?.content ?? p.content;
  const editedAt = saved ? saved.editedAt : (p.editedAt ?? null);

  const saveEdit = async (text: string) => {
    const res = await api.patch(`${config.itemBase}/posts/${p.id}`, { content: text, expectedEditedAt: edit?.stamp ?? null });
    const answer = res.data?.data as { changed?: boolean; editedAt?: string | null } | undefined;
    if (answer?.changed) setSaved({ content: text, editedAt: answer.editedAt ?? editedAt });
    onEdit(null);
    onChanged();
  };

  const authorHref = !p.authorClosed && config.authorHref ? config.authorHref(p.authorId) : null;
  const authorName = <p className="min-w-0 break-words text-sm font-semibold text-gray-900">{p.authorName || 'Member'}</p>;
  const avatar = <Avatar src={p.authorAvatarUrl || undefined} name={p.authorName || 'Member'} size="sm" />;

  return (
    <div ref={root} className="scroll-mt-4">
      <Card className={`!p-4 ${highlighted ? 'ring-2 ring-rsn-red/40' : ''}`} data-testid={`wall-post-${p.id}`}>
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
              <p className="text-[11px] text-gray-400">
                {timeAgo(p.createdAt)}
                {editedAt && <span data-testid={`post-edited-${p.id}`}> · {EDITED_LABEL}</span>}
              </p>
              {showPinBadge && p.pinnedAt && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-rsn-red bg-rsn-red-light px-1.5 py-0.5 rounded-full" data-testid={`pinned-badge-${p.id}`}>
                  <Pin className="h-2.5 w-2.5" /> Pinned
                </span>
              )}
            </div>
            <WallPostBody post={p} content={content} highlighted={highlighted} edit={edit} gone={gone} onEdit={onEdit} onSave={saveEdit} />
            <ReactionSummaryRow post={p} r={r} />
            <WallPostActions
              config={config} post={p} viewer={viewer} userId={userId} content={content} editedAt={editedAt}
              edit={edit} onEdit={onEdit} gone={gone} r={r}
              openComments={openComments} onToggleComments={() => setOpenComments((v) => !v)}
              onChanged={onChanged} onRemoved={onRemoved}
            />
            {openComments && !gone && (
              <WallComments config={config} postId={p.id} viewer={viewer} userId={userId} onChanged={onChanged} />
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
