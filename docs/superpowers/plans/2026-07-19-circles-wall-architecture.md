# Circles + Wall — Architecture (REASON v1 Phases 3–4)

> Status: DESIGN — for Ali's approval before build. Companion to
> `2026-07-17-reason-platform-v1.md` (Phases 1–2 shipped: main `36e64ca`).
> Stefan's locked definitions: circle = group of people with same intent/type;
> circles↔pods many-to-many; circles can nest; admin-created v1; wall = text +
> photos + videos + external shares; seeding list pending ("let's talk").

## 0. The architectural shift this represents

Everything shipped so far is STRUCTURED data (events, matches, ratings,
scheduling). The wall is RSN's first USER-GENERATED CONTENT system. That is a
category change: unbounded growth tables, media, links to arbitrary external
sites, and an abuse surface. The design below treats those as first-class
concerns, not afterthoughts.

## 1. Domain model

```
users ──< circle_members >── circles ──< circle_pods >── pods ──< sessions
                                │ parent_circle_id (nesting, graph-as-tree)
                                └──< circle_posts ──< circle_post_comments
```

- **Circle** = community (WHO). **Pod** = activity flow (WHAT HAPPENS).
- A pod is ATTACHED to circles (link rows), never contained by one. The June
  doc's "Level 2 → Level 3" tree is a presentation convention over a graph.
- The wall belongs to the circle, not the pod.

## 2. Schema (migration 076+, all additive)

```sql
circles (
  id uuid PK,
  name text NOT NULL,                    -- unique per parent, case-insensitive
  description text,
  parent_circle_id uuid NULL REFERENCES circles(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  member_count int NOT NULL DEFAULT 0,   -- denormalised, transactional
  post_count int NOT NULL DEFAULT 0,     -- denormalised, transactional
  archived_at timestamptz NULL,          -- soft archive, never hard delete v1
  created_at / updated_at
)
UNIQUE INDEX ON (lower(name), coalesce(parent_circle_id, uuid_nil()))

circle_members (
  circle_id uuid REFERENCES circles ON DELETE CASCADE,
  user_id   uuid REFERENCES users   ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','moderator')),
  joined_at timestamptz,
  PRIMARY KEY (circle_id, user_id)
)
INDEX ON (user_id)                       -- "my circles" is a hot path

circle_pods (
  circle_id uuid REFERENCES circles ON DELETE CASCADE,
  pod_id    uuid REFERENCES pods    ON DELETE CASCADE,
  added_by  uuid, created_at,
  PRIMARY KEY (circle_id, pod_id)
)
INDEX ON (pod_id)                        -- reverse lookup: pod → its circles

circle_posts (
  id uuid PK,
  client_id uuid NOT NULL,               -- client-generated; UNIQUE(author_id, client_id)
                                         -- makes double-tap/retry submits idempotent
  circle_id uuid REFERENCES circles ON DELETE CASCADE,
  author_id uuid REFERENCES users ON DELETE CASCADE,
  content text CHECK (length(content) <= 8000),
  media jsonb NOT NULL DEFAULT '[]',     -- [{type:'image'|'video', url, meta}]
                                         -- Cloudinary-host-validated server-side
  link_url text NULL,                    -- external share; NO server unfurl v1 (see §4)
  comment_count int NOT NULL DEFAULT 0,  -- denormalised, transactional
  pinned_at timestamptz NULL,
  deleted_at timestamptz NULL,           -- soft delete (moderation reversibility)
  created_at / edited_at
)
INDEX ON (circle_id, created_at DESC) WHERE deleted_at IS NULL   -- THE feed index

circle_post_comments (
  id uuid PK, post_id REFERENCES circle_posts ON DELETE CASCADE,
  author_id uuid REFERENCES users ON DELETE CASCADE,
  content text CHECK (length(content) <= 4000),
  deleted_at timestamptz NULL, created_at
)
INDEX ON (post_id, created_at) WHERE deleted_at IS NULL
```

Notifications: extend type CHECK with 'circle_post' (batched/deduped, see §6).

**Nesting integrity:** `parent_circle_id` can express cycles; Postgres can't
CHECK that. Enforced in the service at write time (admin-only writes, so
contention-free): walk ancestors, reject cycles, cap depth at 3. UI stays flat
in v1 regardless.

**Counters:** member_count / post_count / comment_count increment-decrement in
the SAME transaction as the membership/post/comment write. No COUNT(*) on hot
paths. A weekly recount job (or on-read heal for drift > 0) is the safety net —
same pattern class as encounter finalize: idempotent repair over trust.

## 3. Access control (authz matrix, enforced server-side per route)

| Action | Who (v1) |
|---|---|
| Create / edit / archive circle, manage nesting | admin, super_admin |
| Attach / detach pods | admin, super_admin |
| Join / leave circle | any active member (OPEN JOIN — flagged default) |
| View circles list, circle page, members, wall | any authenticated member |
| Post / comment on wall | CIRCLE MEMBERS only |
| Edit / soft-delete own post or comment | author |
| Delete any post/comment, pin posts | admin, super_admin (+ 'moderator' role reserved in schema for later) |

- Every route re-derives membership/role from the DB — nothing trusted from the
  client. Same middleware pattern as pods/sessions.
- **Blocks respected at read time:** feed and comment reads filter authors the
  viewer has blocked (cheap anti-join on user_blocks). Prevents the wall from
  becoming a harassment bypass around the existing DM/poke block system.
- **Reports:** the existing reports machinery gets `circle_post` /
  `circle_comment` target types so moderation lands in the existing admin page.

## 4. Security decisions (the UGC-specific ones)

1. **Media = Cloudinary only, validated server-side.** Same defence as DM
   attachments: unsigned preset, `res.cloudinary.com` host allowlist enforced
   on write, type allowlist (image, video), size caps (image ≤ 10 MB, video
   ≤ 100 MB) enforced in the upload preset. No arbitrary URLs in `media`.
2. **External shares WITHOUT server-side unfurl in v1.** Fetching arbitrary
   URLs from our server to build previews is an SSRF surface (internal IP
   probing, cloud metadata endpoints). v1 stores the URL, validates scheme
   (http/https only), and renders a link card client-side from the URL parts
   (domain + path). A hardened unfurler (DNS pin, private-IP block, 3 s
   timeout, HTML size cap, og-tags only) is a later, isolated addition.
3. **XSS:** content rendered as React text (escaped); zero
   dangerouslySetInnerHTML; links get rel="noopener noreferrer".
4. **Rate limits:** per-user create limits at the route (posts: 6/min,
   comments: 20/min, joins: 30/hr) on top of the existing edge limiter.
   Content-length caps in both zod schema and DB CHECK (defence in depth).
5. **Privacy:** all circles visible to authenticated members in v1; member
   lists authenticated-only; hidden/private circles are a later `visibility`
   enum, already trivially addable (single column + WHERE clause).

## 5. Feed architecture (the scaling decision that matters)

**v1 = fan-out-on-READ (pull).** A circle wall is one indexed query:

```sql
SELECT p.*, u.display_name, u.avatar_url
FROM circle_posts p JOIN users u ON u.id = p.author_id
WHERE p.circle_id = $1 AND p.deleted_at IS NULL
  AND NOT EXISTS (blocked-author anti-join)
ORDER BY p.created_at DESC, p.id DESC
LIMIT 20 [keyset: AND (created_at, id) < ($cursor_ts, $cursor_id)]
```

- **Keyset pagination, never OFFSET** — offset scans degrade linearly with
  depth; keyset stays O(page) forever. Cursor = (created_at, id).
- Author data joins in one query (no N+1); comment counts are denormalised.
- "All my circles" home feed = same query with `circle_id = ANY(my_circles)`,
  same index. Fine to ~50k users / low-hundreds of circles.
- **The documented switch point:** if an aggregated home feed over many
  hundreds of circles per user ever becomes the hot path, add a Redis
  per-user timeline cache (short TTL) FIRST, and only consider
  fan-out-on-write if that fails. Neither is built now; the schema needs no
  change for either. This is written down so future-us doesn't rediscover it.
- Realtime: v1 = react-query refetch on focus + 30 s interval on an open wall
  (same pattern as the scheduler), plus the existing entity-fanout ping on new
  post so open walls refresh promptly. No new socket rooms; multi-instance
  safe because nothing lives in process memory.

## 6. Reliability decisions

- **Idempotent writes everywhere:** joins/attaches are ON CONFLICT DO NOTHING
  on composite PKs; post creation is deduped by UNIQUE(author_id, client_id) —
  a double-tap or a retried request cannot double-post.
- **Soft delete for all UGC** (deleted_at) — moderation is reversible, FK
  landmines avoided, hard-delete sweep can come later with retention policy.
- **Archive, not delete, for circles** — an archived circle disappears from
  lists but every post/member row survives (Ali's snapshot-regression scar:
  never make destruction the easy path).
- **Notification hygiene:** 'circle_post' notifications are deduped per user
  per circle per hour ("New posts in Founders") — a busy wall must never
  become a bell firehose. Reuses the 24h-dedupe pattern from platform_match.
- **Counter drift:** weekly recount cron (cheap: 3 UPDATEs with subselects) —
  counters are display data, never authorization data, so drift is cosmetic
  and self-healing.
- **Migrations:** all additive; rollback = revert the code, tables sit inert.
- **Soft launch for free:** nav shows Circles only when circles exist (or to
  admins) — shipping the code activates nothing until Stefan's seed circles
  are created, so deploy and launch decouple cleanly.

## 7. Scaling lens (RajaSkill: 10× / 100×)

| Concern | Now (74 users) | 10× (≈1k) | 100× (≈10k+) |
|---|---|---|---|
| Circle list / membership | trivial | indexed PK lookups | same; member_count denormalised |
| Wall read | 1 indexed query | same (keyset) | same; consider Redis timeline for HOME feed only |
| Wall write | 1 insert + counter | same | rate limits already bound worst case |
| Media | Cloudinary CDN | same | cost watch (video bandwidth) — §9 |
| Events in circle | pod_id IN (...) indexed | same | same |
| Process memory | none | multi-instance safe | Redis/socket-adapter path untouched |

No N+1 anywhere: every list endpoint returns its joins in one statement.

## 8. Build workflow (each slice ships through the full gate: unit → full
suite → staging CI → main → Render/Vercel verify → prod E2E headed mobile)

- **P3a — Circles core (~3-4 days):** migration 076 (circles, circle_members,
  circle_pods), service + authz matrix, admin CRUD, join/leave, Circles list
  page + circle page (members, linked pods, upcoming events of those pods),
  nav entry (visible when circles exist or admin), seed Stefan's own examples
  (Founders, AI Developers, Doctors) as editable placeholders.
- **P3b — Pod attachment UX (~1-2 days):** "create pod in this circle"
  (create+link), attach/detach existing pods from circle page, pod page shows
  its circles. Nesting stays schema-only.
- **P4a — Wall: text + comments (~3-4 days):** migration 077 (posts,
  comments, notification type), post/comment services with rate limits +
  blocks-at-read + reports wiring, wall UI with keyset infinite scroll,
  composer, comment threads, admin delete/pin.
- **P4b — Media + shares (~2-3 days):** Cloudinary image/video in the
  composer (reuse DM upload path), video thumbnails via Cloudinary
  transforms, link cards (client-rendered, no unfurl), pinned posts on top.

Unit-test targets: authz matrix (every cell), cycle/depth rejection, counter
transactional integrity, keyset cursor correctness, idempotent join/post,
rate-limit responses, block filtering. Prod E2E per slice mirrors P1/P2 style:
REST drives one side, headed 390 px browser drives the real UI.

## 9. Cost note

Images are cheap; VIDEO is the cost lever (Cloudinary bandwidth). v1 ships
with the 100 MB cap + Cloudinary auto-quality. If wall video takes off, the
upgrade path is Cloudinary's adaptive streaming — flagged, not built.

## 10. Defaults Ali should be able to veto (flagged, not blocking)

1. Open join (anyone joins any circle; admin can remove).
2. All circles visible to all members.
3. Circle membership gates ONLY wall posting — never events or matching.
4. Seed circles = Stefan's own named examples, renameable.
5. Comments are flat (no threads-of-threads) in v1.
