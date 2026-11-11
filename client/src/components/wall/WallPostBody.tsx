// What a post says: its words (cut with "Show more", or its author's edit in their place), the post it shares, its
// pictures and its link card. Split out of WallPostCard (S4 fix round 1), with no change in what is drawn.
//
// A share whose original this viewer may not see (removed, in a closed circle they are outside, or by someone blocked
// either way) shows only "This post isn't available": the server sends no words and no name for it, and the card says
// the same for every reason, so it tells nothing about a block.

import { Link } from 'react-router-dom';
import { ExternalLink, Share2 } from 'lucide-react';
import ClampedText from './ClampedText';
import WallEditForm from './WallEditForm';
import { LINKED_POST_REMOVED, SHARED_UNAVAILABLE, domainOf } from './wall-logic';
import type { WallPost } from './wall-types';
import type { PostEdit } from './WallPostCard';

export default function WallPostBody({ post: p, content, highlighted, edit, gone, onEdit, onSave }: {
  post: WallPost;
  /** The words as the screen has them (the author's last save included). */
  content: string;
  highlighted: boolean;
  edit: PostEdit | null;
  gone?: boolean;
  onEdit: (draft: string | null) => void;
  onSave: (text: string) => Promise<void>;
}) {
  const sharedImage = p.sharedFrom?.media?.find((m) => m.type === 'image');
  return (
    <>
      {edit ? (
        <WallEditForm
          draft={edit.draft}
          onDraft={(text) => onEdit(text)}
          original={content}
          maxLength={8000}
          allowEmpty={p.media.length > 0 || !!p.sharedFrom || !!p.sharedUnavailable}
          gone={gone ? LINKED_POST_REMOVED : undefined}
          label="Edit your post"
          onSave={onSave}
          onCancel={() => onEdit(null)}
          testId={`edit-post-${p.id}`}
        />
      ) : content && (
        <div className="mt-1 text-sm text-gray-800">
          <ClampedText text={content} kind="post" open={highlighted} testId={`post-text-${p.id}`} />
        </div>
      )}
      {p.sharedFrom ? (
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
      ) : p.sharedUnavailable && (
        <p
          className="mt-2 flex items-center gap-1 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500"
          data-testid={`shared-unavailable-${p.id}`}
        >
          <Share2 className="h-3 w-3" aria-hidden /> {SHARED_UNAVAILABLE}
        </p>
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
    </>
  );
}
