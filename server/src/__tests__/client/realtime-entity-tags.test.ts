// ─── The client's realtime tags are the server's (21 Oct 2026) ───────────────
// A query only refreshes when the tag it declares is, letter for letter, the tag the server sends.
// Both sides build tags from their own `E` (client/src/realtime/entities.ts and
// server/src/realtime/entities.ts), so the two are compared here builder by builder. The entity tags
// (an organisation members create; entity:<id> and user:<id>:entities) arrived on 21 Oct 2026.

import { E as clientE } from '../../../../client/src/realtime/entities';
import { E as serverE } from '../../realtime/entities';

type Builders = Record<string, string | ((id: string) => string)>;
const tagOf = (builder: string | ((id: string) => string)) => (typeof builder === 'function' ? builder('id-1') : builder);

describe('the realtime tags', () => {
  it('the client builds an entity\'s tag and a member\'s entities tag as the server sends them', () => {
    expect(clientE.entity('e-1')).toBe('entity:e-1');
    expect(clientE.userEntities('u-1')).toBe('user:u-1:entities');
    expect(clientE.entity('e-1')).toBe(serverE.entity('e-1'));
    expect(clientE.userEntities('u-1')).toBe(serverE.userEntities('u-1'));
  });

  it('every builder on either side is on the other, and builds the same tag', () => {
    const client = clientE as unknown as Builders;
    const server = serverE as unknown as Builders;
    expect(Object.keys(client).sort()).toEqual(Object.keys(server).sort());
    for (const key of Object.keys(server)) expect({ key, tag: tagOf(client[key]) }).toEqual({ key, tag: tagOf(server[key]) });
  });
});
