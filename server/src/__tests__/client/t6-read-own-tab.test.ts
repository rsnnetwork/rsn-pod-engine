// ─── The tab that reads a conversation clears its own count (1 Nov 2026, the preview's T6 failure) ──────────────────
//
// On the preview against production, B opened A's conversation in a fresh tab and that tab kept "(1) REASON" (and
// the Messages badge kept 1) while B's other tab went back to "REASON". A fresh tab marks the conversation read by
// REST (its socket is not up yet) while it reads its first unread count; from far away the count is read before the
// read lands, and the server's user:<id>:dms tag for the read goes out before that tab's socket has joined the
// member's room, so the one tab that did the reading never heard it and nothing asked again. The reader's own tab now
// refreshes the same tagged reads itself once its read has answered, for a 1:1 and for a group alike.
// e2e/tests/n1-t6-messaging.spec.ts test 1 holds the read and the socket back to prove it in real browsers.

import * as fs from 'fs';
import * as path from 'path';
import { QueryClient } from '@tanstack/query-core';
import { invalidateEntities, touchesEntities } from '../../../../client/src/realtime/invalidate-entities';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('invalidateEntities: the one rule for which reads a tag refreshes', () => {
  async function cacheWith(): Promise<QueryClient> {
    const qc = new QueryClient();
    await qc.fetchQuery({ queryKey: ['dm-unread-count'], queryFn: () => 1, meta: { entities: ['user:b:dms'] } });
    await qc.fetchQuery({ queryKey: ['dm-messages', 'c1'], queryFn: () => [], meta: { entities: ['dm-conversation:c1'] } });
    await qc.fetchQuery({ queryKey: ['someone-else'], queryFn: () => 0, meta: { entities: ['user:z:dms'] } });
    await qc.fetchQuery({ queryKey: ['untagged'], queryFn: () => 0 });
    return qc;
  }
  const invalidated = (qc: QueryClient, key: unknown[]) => qc.getQueryCache().find({ queryKey: key, exact: true })?.state.isInvalidated;

  it('refreshes exactly the reads that declare one of the tags', async () => {
    const qc = await cacheWith();
    await invalidateEntities(qc, ['dm-conversation:c1', 'user:b:dms']);
    expect(invalidated(qc, ['dm-unread-count'])).toBe(true);
    expect(invalidated(qc, ['dm-messages', 'c1'])).toBe(true);
    expect(invalidated(qc, ['someone-else'])).toBe(false);
    expect(invalidated(qc, ['untagged'])).toBe(false);
    qc.clear();
  });

  it('no tags refresh nothing', async () => {
    const qc = await cacheWith();
    await invalidateEntities(qc, []);
    expect(invalidated(qc, ['dm-unread-count'])).toBe(false);
    qc.clear();
  });

  it('a read with no or empty meta.entities never matches', () => {
    const tags = new Set(['user:b:dms']);
    expect(touchesEntities({ meta: undefined }, tags)).toBe(false);
    expect(touchesEntities({ meta: { entities: [] } }, tags)).toBe(false);
    expect(touchesEntities({ meta: { entities: 'user:b:dms' } }, tags)).toBe(false);
    expect(touchesEntities({ meta: { entities: ['x', 'user:b:dms'] } }, tags)).toBe(true);
  });

  it('entity:changed from the server goes through the same rule', () => {
    // The app's listener lives beside the rule (subscribeEntitySync, P1 item 17) and hands it every incoming tag.
    const src = read('realtime/useEntityChangedHandler.ts');
    const rule = read('realtime/invalidate-entities.ts');
    expect(src).toMatch(/import \{ subscribeEntitySync \} from '\.\/invalidate-entities';/);
    // Fix wave 2, fix round 1: through readChanged, which is invalidateEntities plus a re-read of a first read on its way.
    expect(rule).toMatch(/const entities = Array\.isArray\(data\?\.entities\) \? data\.entities : \[\];/);
    expect(rule).toMatch(/void readChanged\(client, entities\);/);
    expect(rule).toMatch(/return Promise\.all\(\[invalidateEntities\(client, entities\), /);
    expect(src).not.toMatch(/predicate:/);
  });
});

describe('the reader\'s own tab does not wait for its own read to come back over the socket', () => {
  it('a 1:1 read by REST refreshes this tab\'s conversation and Messages count when it answers', () => {
    const src = read('features/messages/thread/useThreadMessages.ts');
    const rest = src.slice(src.indexOf('api.post(`/dm/conversations/${conversationId}/read`)'));
    expect(rest).toMatch(/^api\.post\(`\/dm\/conversations\/\$\{conversationId\}\/read`\)\s*\.then\(\(\) => invalidateEntities\(queryClient, readTags\(conversationId\)\)\)/);
    expect(src).toMatch(/E\.dmConversation\(conversationId\)/);
    expect(src).toMatch(/E\.userDms\(me\)/);
    expect(src).toMatch(/import \{ queryClient \} from '@\/lib\/queryClient';/);
  });

  it('a group read refreshes this tab\'s Messages count when it answers (the tag the server sends for it)', () => {
    const src = read('features/messages/useGroups.ts');
    const hook = src.slice(src.indexOf('export function useMarkGroupRead'), src.indexOf('export function useLeaveGroup'));
    expect(hook).toMatch(/onSuccess: \(\) => \{\s*if \(me\) void invalidateEntities\(qc, \[E\.userDms\(me\)\]\);\s*\}/);
  });
});
