// The author's open edit of a post, held by the wall (Shirley pilot S4), so the card can be drawn again (a refetch,
// "Show more") without losing what was typed. Split out of Wall.tsx in fix round 1.
//
// The edited post is drawn even when it is not among the cards the wall draws (`held`): loaded but past "Show more",
// pushed to the next page by a newer post, or removed. Fix round 1: a post not on the pages loaded now is looked up by
// its id, and only the server's 404 marks it gone ("This post was removed.", the text kept to copy). Until then, and on
// any other answer, the edit stays open and can be saved (a save of a post that has gone is told so by the server).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { isNotFound, retryUnlessAnswered } from './wall-logic';
import type { WallConfig, WallPost } from './wall-types';
import type { PostEdit } from './WallPostCard';

export function useHeldPostEdit(config: WallConfig, loaded: { ids: Set<string>; rest: WallPost[]; linkedPostId?: string }) {
  const [editing, setEditing] = useState<(PostEdit & { post: WallPost }) | null>(null);

  const out = editing && !loaded.ids.has(editing.post.id) && loaded.linkedPostId !== editing.post.id ? editing.post.id : undefined;
  const lookup = useQuery<WallPost>({
    queryKey: config.keys.post(out ?? ''),
    queryFn: () => api.get(`${config.itemBase}/posts/${out}`).then((r) => r.data.data as WallPost),
    enabled: out !== undefined,
    retry: retryUnlessAnswered,
    meta: { entities: config.entities.post(out ?? '') },
  });

  /** The edited post to draw on its own when it is not among `drawn`, with whether the server says it has gone. */
  const heldFor = (drawn: Set<string>): { post: WallPost; gone: boolean } | null => {
    if (!editing || drawn.has(editing.post.id)) return null;
    const post = loaded.rest.find((p) => p.id === editing.post.id) ?? (out ? lookup.data : undefined) ?? editing.post;
    return { post, gone: out !== undefined && lookup.isError && isNotFound(lookup.error) };
  };

  /** Open the edit with these words (and the stamp the card shows, a save of a moment ago included), change them, or close it. */
  const editFor = (p: WallPost) => (draft: string | null, stamp?: string | null) => setEditing((cur) => {
    if (draft === null) return null;
    return cur && cur.post.id === p.id ? { ...cur, draft } : { post: p, draft, stamp: stamp !== undefined ? stamp : (p.editedAt ?? null) };
  });

  const editOf = (p: WallPost): PostEdit | null =>
    (editing && editing.post.id === p.id ? { draft: editing.draft, stamp: editing.stamp } : null);

  return { editingId: editing?.post.id, heldFor, editFor, editOf };
}
