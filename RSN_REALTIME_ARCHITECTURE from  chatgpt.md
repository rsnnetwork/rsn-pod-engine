# chatgptforRSN.md

# RSN Realtime Architecture Refactor

This file contains the recommended realtime refactor architecture for RSN using:
Node.js (Express) + PostgreSQL (Neon) + Socket.IO + Redis + React + Vite + React Query v5.

## Core Decision

Use:

- Generic `entity:changed` socket event
- Query-local `realtimeTags`
- Predicate invalidation in React Query
- Redis pub/sub fanout
- Refetch-by-default strategy

## Principle

Server owns:
- what changed

Client owns:
- what depends on it

## Event Contract

```ts
type EntityChangedEvent = {
  scopes: string[];
  cause?: string;
  timestamp?: number;
};
```

Example:

```json
{
  "scopes": [
    "pod:123",
    "user:456"
  ],
  "cause": "member_removed"
}
```

## Query Pattern

```ts
return useRealtimeQuery({
  queryKey: ['pod-members', podId],
  queryFn: fetchMembers,
  realtimeTags: [`pod:${podId}`]
});
```

## Global Listener

```ts
queryClient.invalidateQueries({
  predicate(query) {
    const tags =
      query.meta?.realtimeTags ?? [];

    return tags.some(tag =>
      changedScopes.has(tag)
    );
  }
});
```

## Rules

1. Every query MUST declare `realtimeTags`
2. Every mutation MUST emit scopes
3. Only use `entity:changed`
4. Never hard-code query invalidation
5. Refetch > patch by default
6. Polling is backup only

## Migration

1. Add Redis pub/sub event layer
2. Add `useRealtimeQuery()`
3. Add `useRealtimeInvalidation()`
4. Replace mutation fanouts with `emitEntityChanged()`
5. Remove NotificationBell invalidation mapping

Outcome:
Realtime becomes a systemic property instead of manual bug fixing.
