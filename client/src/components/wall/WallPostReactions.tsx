// A post's reactions: the member's one reaction, the count and the top three, the Like button and the picker. Split
// out of WallPostCard (S4 fix round 1), with no change in behaviour.
//
// What the server answered to the member's last reaction is shown until the post itself brings the same numbers back
// (a change that changed nothing tells no screen, so there would be no echo to wait for).

import { useEffect, useState } from 'react';
import { ChevronDown, ThumbsUp } from 'lucide-react';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { REACTIONS, WALL_ACTION_BUTTON, isConflict, reactionOf, wallErrorSentence } from './wall-logic';
import type { ReactionKey, WallConfig, WallPost, WallViewer } from './wall-types';

export function useWallReactions(p: WallPost, viewer: WallViewer, config: WallConfig, onChanged: () => void) {
  const addToast = useToastStore((s) => s.addToast);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [local, setLocal] = useState<{ reactionCount: number; reactions: WallPost['reactions']; myReaction: ReactionKey | null } | null>(null);
  const reactionsSeen = `${p.reactionCount}|${p.myReaction}|${JSON.stringify(p.reactions)}`;
  useEffect(() => { setLocal(null); }, [reactionsSeen]);

  const reactionCount = local?.reactionCount ?? p.reactionCount ?? 0;
  const reactions = local?.reactions ?? p.reactions ?? {};
  const myReaction = local ? local.myReaction : (p.myReaction ?? null);
  const mine = reactionOf(myReaction);
  const topEmojis = REACTIONS.filter((r) => (reactions[r.key] ?? 0) > 0)
    .sort((a, b) => (reactions[b.key] ?? 0) - (reactions[a.key] ?? 0)).slice(0, 3);

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

  return { reactionCount, myReaction, mine, topEmojis, react, reacting, pickerOpen, setPickerOpen };
}

export type WallReactions = ReturnType<typeof useWallReactions>;

/** The count of reactions (with the top three) and of comments, when there are any. */
export function ReactionSummaryRow({ post: p, r }: { post: WallPost; r: WallReactions }) {
  if (r.reactionCount === 0 && p.commentCount === 0) return null;
  return (
    <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
      <span data-testid={`reaction-summary-${p.id}`} className="flex items-center gap-1">
        {r.reactionCount > 0 && (
          <>
            <span aria-hidden>{r.topEmojis.map((x) => x.emoji).join('')}</span>
            <span>{r.reactionCount}</span>
          </>
        )}
      </span>
      {p.commentCount > 0 && <span>{p.commentCount} {p.commentCount === 1 ? 'comment' : 'comments'}</span>}
    </div>
  );
}

/** Like (or remove your reaction) and the 44px toggle that opens the picker. */
export function ReactButtons({ post: p, r }: { post: WallPost; r: WallReactions }) {
  return (
    <>
      <button
        type="button"
        onClick={() => void (r.mine ? r.react(null) : r.react('like'))}
        disabled={r.reacting}
        aria-pressed={!!r.mine}
        aria-label={r.mine ? `Remove your ${r.mine.label} reaction` : 'Like'}
        className={`${WALL_ACTION_BUTTON} ${r.mine ? 'text-rsn-red' : ''}`}
        data-testid={`react-button-${p.id}`}
      >
        {r.mine ? <span aria-hidden>{r.mine.emoji}</span> : <ThumbsUp className="h-3.5 w-3.5" />}
        {r.mine ? r.mine.label : 'Like'}
      </button>
      <button
        type="button"
        onClick={() => r.setPickerOpen((v) => !v)}
        aria-label="Choose a reaction"
        aria-expanded={r.pickerOpen}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700"
        data-testid={`reaction-picker-toggle-${p.id}`}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </>
  );
}

/** The five reactions as a row of 44px buttons that wraps. */
export function ReactionPicker({ post: p, r }: { post: WallPost; r: WallReactions }) {
  return (
    <div
      role="group" aria-label="Choose a reaction"
      className="mt-1 flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm"
      data-testid={`reaction-picker-${p.id}`}
    >
      {REACTIONS.map((x) => (
        <button
          key={x.key} type="button"
          onClick={() => void r.react(r.myReaction === x.key ? null : x.key)}
          aria-label={`React: ${x.label}`}
          aria-pressed={r.myReaction === x.key}
          className={`flex min-h-[44px] min-w-[44px] items-center gap-1 rounded-lg px-2 text-xs hover:bg-gray-50 ${r.myReaction === x.key ? 'bg-rsn-red-light text-rsn-red' : 'text-gray-700'}`}
        >
          <span className="text-lg" aria-hidden>{x.emoji}</span>
          <span className="hidden sm:inline">{x.label}</span>
        </button>
      ))}
    </div>
  );
}
