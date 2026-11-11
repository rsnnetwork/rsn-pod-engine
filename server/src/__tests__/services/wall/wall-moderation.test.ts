// ─── What both walls share about editing and moderation (Shirley pilot S4, 11 Nov 2026) ─────────────────────────

import {
  EDIT_CONFLICT, PINS_FULL, WALL_BELL_TYPES, WALL_PINNED_MAX, commentBellLink, editConflict, editStampHolds, pinsFull, postRemoved,
  commentRemoved, purgeCommentBells, purgePostBells, recordModeration, tellBellOwners,
} from '../../../services/wall/wall-moderation';

describe('the edit stamp an editor opened', () => {
  const at = new Date('2026-11-11T10:30:00.123Z');

  it('is not compared when the editor did not send one', () => {
    expect(editStampHolds(at, undefined)).toBe(true);
    expect(editStampHolds(null, undefined)).toBe(true);
  });

  it('holds when it is the row\'s, to the millisecond, as it travels over JSON', () => {
    expect(editStampHolds(at, '2026-11-11T10:30:00.123Z')).toBe(true);
    expect(editStampHolds(at, '2026-11-11T11:30:00.123+01:00')).toBe(true);
    expect(editStampHolds(null, null)).toBe(true);
  });

  it('fails when the row was edited since (or the editor opened an edited post that is now plain), or the stamp is not a time', () => {
    expect(editStampHolds(at, null)).toBe(false);
    expect(editStampHolds(null, '2026-11-11T10:30:00.123Z')).toBe(false);
    expect(editStampHolds(at, '2026-11-11T10:30:00.124Z')).toBe(false);
    expect(editStampHolds(at, 'yesterday')).toBe(false);
  });
});

describe('the words both walls say', () => {
  it('at most three pinned, and a fourth is refused in words', () => {
    expect(WALL_PINNED_MAX).toBe(3);
    expect(pinsFull()).toMatchObject({ statusCode: 409, code: 'WALL_PINS_FULL', message: PINS_FULL });
    expect(PINS_FULL).toBe('A wall can have at most 3 pinned posts. Unpin one first.');
  });

  it('something removed a moment before says what was removed', () => {
    expect(postRemoved('p')).toMatchObject({ statusCode: 404, message: 'This post was removed.' });
    expect(commentRemoved('c')).toMatchObject({ statusCode: 404, message: 'This comment was removed.' });
    expect(editConflict()).toMatchObject({ statusCode: 409, code: 'WALL_EDIT_CONFLICT', message: EDIT_CONFLICT });
  });
});

describe('recordModeration', () => {
  it('writes one audit_log row on the transaction\'s own client: who, what, which space, and the words as they were', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await recordModeration({ query } as never, {
      actorId: 'mod-1', action: 'wall_post_removed', space: 'circle', spaceId: 'c-1',
      snapshot: { postId: 'p-1', authorId: 'a-1', content: 'rude', createdAt: '2026-11-11T10:00:00.000Z', editedAt: null },
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe('INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)');
    expect(params.slice(0, 4)).toEqual(['mod-1', 'wall_post_removed', 'circle', 'c-1']);
    expect(JSON.parse(params[4])).toEqual({
      wall: 'circle', postId: 'p-1', authorId: 'a-1', content: 'rude', createdAt: '2026-11-11T10:00:00.000Z', editedAt: null,
    });
  });
});

describe('fix round 1: bells that carry removed words', () => {
  it('a comment\'s bell link is the post\'s, naming the comment', () => {
    expect(commentBellLink('/circles/c?post=p', 'k')).toBe('/circles/c?post=p&comment=k');
  });

  it('a post\'s bells: every wall bell type of the space, its link or a comment link under it; each person once', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'a' }] });
    await expect(purgePostBells({ query } as never, 'pod', '/pods/x?post=p')).resolves.toEqual(['a', 'b']);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ').trim()).toBe(
      `DELETE FROM notifications WHERE type IN ('pod_post', 'pod_reaction', 'pod_comment', 'pod_reply') AND (link = $1 OR link LIKE $2) RETURNING user_id`,
    );
    expect(params).toEqual(['/pods/x?post=p', '/pods/x?post=p&%']);
    expect(WALL_BELL_TYPES.pod).toEqual(['pod_post', 'pod_reaction', 'pod_comment', 'pod_reply']);
    expect(WALL_BELL_TYPES.circle).toEqual(['circle_post', 'circle_reaction', 'circle_comment', 'circle_reply']);
  });

  it('comments\' bells: exactly the links named; none named, nothing asked', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ user_id: 'c' }] });
    await expect(purgeCommentBells({ query } as never, 'circle', [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await expect(purgeCommentBells({ query } as never, 'circle', ['/l1', '/l2'])).resolves.toEqual(['c']);
    expect(String(query.mock.calls[0][0])).toBe(`DELETE FROM notifications WHERE type IN ('circle_post', 'circle_reaction', 'circle_comment', 'circle_reply') AND link = ANY($1::text[]) RETURNING user_id`);
    expect(query.mock.calls[0][1]).toEqual([['/l1', '/l2']]);
  });

  it('a link used as a LIKE prefix cannot widen it: %, _ and backslash are escaped', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await purgePostBells({ query } as never, 'circle', '/c/a_b%c\\d');
    expect(query.mock.calls[0][1][1]).toBe('/c/a\\_b\\%c\\\\d&%');
  });

  it('telling the people is quiet when there is no socket server', async () => {
    await expect(tellBellOwners(['a'])).resolves.toBeUndefined();
  });
});
