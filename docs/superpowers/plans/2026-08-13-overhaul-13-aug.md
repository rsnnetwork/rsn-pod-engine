# RSN 13 August Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every item from the 13 August overhaul meeting — a first agent created at the end of onboarding, LinkedIn-inferred titles that stop steering the matcher, working bare-domain links, a restructured dashboard, platform-wide people search, member invites, circle invites, a new-match badge, a rebuilt profile card, a sender-aware message view, and a warmer host prompt.

**Architecture:** Four waves, each independently shippable to production. Wave A is client-only and lands the visible changes Claus asked for. Wave B fixes two correctness problems in data that is silently steering matching. Wave C adds three new capabilities (search, member invites, circle invites) with new routes and one migration. Wave D is presentation and copy. Every wave follows the house rule: TDD, full server suite, staging CI, main, then headed Playwright smokes against production.

**Tech Stack:** Node/Express/TypeScript server, React 18 + Vite client, `@rsn/shared` workspace, Neon Postgres (migrations auto-run on boot, currently at 087), Socket.IO realtime with `emitEntities` → `entity:changed`, Jest (server), Playwright (E2E, headed, against production).

**Spec:** `docs/superpowers/specs/2026-08-13-overhaul-meeting.md`

## Execution notes (3 Sep 2026)

- **Wave A shipped 17 Aug** (main = 6bc0e7a; headed smoke passed 17 Aug 21:09). Tasks A1–A5 done as written; A4 needed one follow-up (e447cbb) for a duplicate badge on drawer-open resize.
- **Stefan's deadline:** platform onboarding-ready by Monday 7 Sep 2026. Ship order for the remaining waves: B2 → C2 → D3 → D2 → C1 → D1 → B1 (alone, rescore after) → C3.
- **B2 deviations from the plan as written**, found in the audit before coding:
  - The completion endpoint is `POST /onboarding/confirm` (not `/onboarding/chat/complete`); the hook sits right after `saveIntentAndComplete` in `server/src/routes/onboarding.ts`.
  - Agents are created **one per designation the member named**, mirroring migration 087, so new and old members look the same on Suggestions. One designation keeps the member's sentence as the search; several split into one agent each searching for that designation alone; none named → a single "People I want to meet" agent, only for a member with no agents yet.
  - **Re-onboarding must not duplicate.** 42 members sit at `update_required` (083) and will pass through `/confirm` on next login; most already hold 087 agents. `createFirstAgents` skips any label the member already has and never adds the generic agent to someone who has agents.
  - The source text is what the member SAID (`desiredPeople` + `desiredRoles`, falling back to `reasonForMeeting`), not the enrichment-merged `who_i_want_to_meet` column — B1's spirit, applied early.
  - Members who completed the chat after 087 ran (4 Aug) and therefore have no agent are backfilled by `server/scripts/backfill-first-agents.ts` (dry run by default, `--apply` to create), using the same planner.
  - The client lands the member on `/agents` with a toast naming the agents, rather than a closing chat bubble (the confirm step already navigates away).
  - E2E: `e2e/tests/first-agent.spec.ts` drives the real `/confirm` (real Anthropic extraction). A 503 there means the prepaid key is empty and the test says so.

## Global Constraints

- **Mobile-first, non-negotiable.** Every UI change must work at 360px, 390–414px, 768px, 1024px and 1280px+. Tap targets ≥44px. No horizontal scroll. Verify with Playwright `boundingBox()` against the viewport, not `isVisible()`.
- **Realtime guard.** Every `useQuery` must carry `meta: { entities: [...] }` or a single-line `// realtime: skip — reason` comment on the immediately preceding line. `node scripts/check-realtime-entities.js` fails the build otherwise.
- **No AI attribution** in commit messages, PR text, or anything pushed to a remote. No `Co-Authored-By`, no "Generated with", no 🤖.
- **Git identity:** this repo commits as `RSN Network <dev@rsn.network>`. Run `gh auth switch -u rsnnetwork` before any push.
- **Branch flow:** work on `overhaul-truthful-loop` → push to `staging` (CI gate) → on green, push to `main` (deploys Render + Vercel).
- **`ROOM_EVICTION_ENABLED` stays false** on Render. Do not enable it.
- **Never `taskkill` all node.exe.** Kill by PID only.
- **Production smokes are mandatory** before reporting any wave complete: headed Playwright covering use cases *and* edge cases, asserting outcomes (stored rows, counts, rendered state), never mere visibility.
- **Prod data changes** are scoped to exact IDs or emails, never `LIKE '%name%'`, and always `SELECT` and confirm the count first.
- E2E test accounts are created with `job_title = 'Test Account'`. Any test needing a role must set `job_title` **and** `professional_role` explicitly — the matcher buckets both.

---

# WAVE A — Visible progress (client-only, no migration)

Claus explicitly asked for small but visible progress. Nothing in this wave touches the database or the matching engine, so it can ship the same day.

---

### Task A1: Bare-domain links become real links

The linkifier only matches `https?://`, so `www.fathom.video/abc` renders as dead text. All three call sites (circle wall, live chat, live session banner) share `Linkify`, so one fix covers them.

**Files:**
- Modify: `client/src/components/ui/Linkify.tsx`
- Test: `e2e/tests/circle-links.spec.ts` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Linkify` keeps its existing signature `({ text, className }: { text: string; className?: string })`. Behaviour widens only.

- [ ] **Step 1: Read the current component**

Read `client/src/components/ui/Linkify.tsx` in full. Note `URL_PATTERN`, `IS_URL`, and `TRAILING_PUNCTUATION`. The security rule matters: only `http`/`https` may ever become an anchor, and text is split into React nodes, never injected as HTML. That must survive this change.

- [ ] **Step 2: Write the failing E2E cases**

Add to `e2e/tests/circle-links.spec.ts`, after the existing multi-URL test:

```typescript
const BARE = 'www.fathom.video/share/abc123';

test('a bare www link is clickable and gets an https scheme', async () => {
  test.setTimeout(180_000);
  await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: `Recording is at ${BARE} — have a look.`,
  });

  const page = await openWall(member);
  // The href must be absolute, or the browser resolves it against app.rsn.network.
  const link = page.locator(`a[href="https://${BARE}"]`).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  // The visible text stays as the member typed it.
  await expect(link).toHaveText(BARE);
  console.log('  ✓ bare www link resolved to an absolute https href.');
});

test('a bare domain is NOT invented out of ordinary prose', async () => {
  test.setTimeout(180_000);
  await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: 'Ask me about node.js vs deno. Costs approx.4 hours. See e.g. below.',
  });

  const page = await openWall(member);
  // node.js, approx.4 and e.g. must never become links.
  await expect(page.locator('a[href*="node.js"]')).toHaveCount(0);
  await expect(page.locator('a[href*="approx"]')).toHaveCount(0);
  await expect(page.locator('a[href*="e.g"]')).toHaveCount(0);
  console.log('  ✓ prose containing dots stayed prose.');
});
```

- [ ] **Step 3: Run them to verify they fail**

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/circle-links.spec.ts --workers=1 --retries=0 -g "bare"
```

Expected: the first FAILS (no anchor found — the text is dead), the second PASSES already (nothing is linked at all yet). Both must pass at the end.

- [ ] **Step 4: Widen the pattern**

Replace the constants and the branch in `client/src/components/ui/Linkify.tsx`:

```tsx
// A scheme-ful URL, or a bare domain that starts with www. — "www.fathom.video"
// is what people actually paste, and it rendered as dead text until 13 Aug.
// Bare domains WITHOUT www. are deliberately excluded: "node.js", "approx.4"
// and "e.g." are ordinary prose, and guessing at them turns writing into links.
const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<>"')\]]+)/gi;
const IS_URL = /^(?:https?:\/\/|www\.)/i;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** A bare www. host needs a scheme, or the browser resolves it against our own origin. */
function toHref(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
```

Then in the render, keep the visible text as typed but link to the absolute href:

```tsx
        const trailing = part.match(TRAILING_PUNCTUATION)?.[0] ?? '';
        const shown = trailing ? part.slice(0, -trailing.length) : part;
        return (
          <span key={i}>
            <a
              href={toHref(shown)}
              target="_blank"
              rel="noopener noreferrer"
              className={className ?? 'break-all text-rsn-red underline hover:opacity-80'}
            >
              {shown}
            </a>
            {trailing}
          </span>
        );
```

- [ ] **Step 5: Run the E2E cases to verify they pass**

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/circle-links.spec.ts --workers=1 --retries=0
```

Expected: all cases PASS, including the pre-existing security case asserting `javascript:` never becomes a link. If that one fails, the scheme allowlist has been broken — stop and fix.

- [ ] **Step 6: Typecheck and commit**

```bash
cd client && npx tsc --noEmit
git add client/src/components/ui/Linkify.tsx e2e/tests/circle-links.spec.ts
git commit -m "Bare www links are real links, without turning prose into one"
```

---

### Task A2: Rename Matches to Suggestions

Decision recorded in the spec: rename only. No recommendation umbrella.

**Files:**
- Modify: `client/src/components/layout/AppLayout.tsx` (nav item labelled `Matches`, pointing at `/agents`)
- Modify: `client/src/features/agents/AgentsPage.tsx` (page heading)
- Test: `e2e/tests/matching-agents.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the nav label string `Suggestions`. Routes are unchanged — `/agents` stays `/agents`, `/matches` stays reachable.

- [ ] **Step 1: Update the failing assertions first**

In `e2e/tests/matching-agents.spec.ts`, the dashboard test asserts on headings. Add to the widths test:

```typescript
  // 13 Aug: "Matches" became "Suggestions" in the nav. The route did not change.
  await expect(page.getByRole('link', { name: 'Suggestions' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Matches$/ })).toHaveCount(0);
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/matching-agents.spec.ts -g "widths" --workers=1 --retries=0
```

Expected: FAIL — no link named Suggestions.

- [ ] **Step 3: Rename the nav item**

In `client/src/components/layout/AppLayout.tsx`, change the label only:

```tsx
    // Wave 2: agents are how you look for people now. /matches remains
    // reachable as the browse-everyone fallback, just not the front door.
    // 13 Aug: labelled "Suggestions" — the page holds standing searches and
    // what they found, which is not the same as a list of matches.
    { to: '/agents', icon: Sparkles, label: 'Suggestions' },
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/matching-agents.spec.ts -g "widths" --workers=1 --retries=0
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/layout/AppLayout.tsx e2e/tests/matching-agents.spec.ts
git commit -m "Nav: Matches becomes Suggestions"
```

---

### Task A3: Dashboard reorder and tile restructure

Current `client/src/features/home/HomePage.tsx` shows three stat tiles — My Pods, Invites Created, Upcoming Events — then separate action cards, then a checklist. The meeting asked for Matches → Pods → Circles → Messages, with each tile owning its own action button, and events/invites demoted to a second row.

**Files:**
- Modify: `client/src/features/home/HomePage.tsx`
- Test: `e2e/tests/wave12-edge-cases.spec.ts` (new test appended)

**Interfaces:**
- Consumes: `GET /agents` (returns `{ id, label, matchCount, askedCount, status }[]`), the existing pods/invites/sessions queries already in the file, `GET /circles` and `GET /dm/conversations`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Read the page and its queries**

Read `client/src/features/home/HomePage.tsx` in full. Note every existing `useQuery` and its `meta.entities` value — new queries must follow the same pattern or the realtime guard fails the build.

- [ ] **Step 2: Write the failing test**

Append to `e2e/tests/wave12-edge-cases.spec.ts`:

```typescript
test('the dashboard leads with Suggestions, then Pods, Circles, Messages', async () => {
  test.setTimeout(180_000);
  const page = await openAs(owner, '/');
  const tiles = page.locator('[data-testid^="tile-"]');
  await expect(tiles.first()).toBeVisible({ timeout: 30_000 });

  const order = await tiles.evaluateAll(els =>
    els.map(e => e.getAttribute('data-testid')));
  expect(order.slice(0, 4)).toEqual([
    'tile-suggestions', 'tile-pods', 'tile-circles', 'tile-messages',
  ]);

  // Each tile owns its action rather than a separate button elsewhere.
  for (const id of order.slice(0, 4)) {
    const btn = page.locator(`[data-testid="${id}"] a, [data-testid="${id}"] button`);
    expect(await btn.count(), `${id} has its own action`).toBeGreaterThan(0);
    const box = await btn.first().boundingBox();
    expect(box!.height, `${id} tap target`).toBeGreaterThanOrEqual(44);
  }

  // 360px floor: no horizontal overflow.
  await page.setViewportSize({ width: 360, height: 800 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);
  console.log('  ✓ dashboard order, per-tile actions, 44px targets, 360px clean.');
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/wave12-edge-cases.spec.ts -g "leads with Suggestions" --workers=1 --retries=0
```

Expected: FAIL — no elements matching `[data-testid^="tile-"]`.

- [ ] **Step 4: Add the two missing queries**

In `HomePage.tsx`, alongside the existing queries:

```tsx
  const { data: agents } = useQuery({
    queryKey: ['agents', false],
    queryFn: () => api.get('/agents').then(r => r.data.data as Array<{ matchCount: number }>),
    meta: { entities: currentUserId ? [E.user(currentUserId)] : [] },
  });

  const { data: circles } = useQuery({
    queryKey: ['circles'],
    queryFn: () => api.get('/circles').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.user(currentUserId)] : [] },
  });

  const { data: conversations } = useQuery({
    queryKey: ['dm-inbox'],
    queryFn: () => api.get('/dm/conversations').then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.user(currentUserId)] : [] },
  });

  const suggestionCount = (agents ?? []).reduce((n, a) => n + (a.matchCount || 0), 0);
  const circleCount = (circles ?? []).length;
  const unreadCount = (conversations ?? []).filter((c: any) => c.unreadCount > 0).length;
```

- [ ] **Step 5: Replace the tile row with a four-tile grid**

Replace the three existing stat `<Card>` blocks with a shared tile. Add above the component:

```tsx
function Tile({ id, label, value, hint, to, action }: {
  id: string; label: string; value: number; hint: string; to: string; action: string;
}) {
  return (
    <Card className="flex flex-col justify-between !p-4" data-testid={`tile-${id}`}>
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="mt-0.5 text-2xl font-bold text-[#1a1a2e]">{value}</p>
        <p className="mt-0.5 text-xs text-gray-400">{hint}</p>
      </div>
      {/* The action lives INSIDE the tile it belongs to (13 Aug meeting) rather
          than in a separate row of buttons with no obvious owner. */}
      <Link
        to={to}
        className="mt-3 flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 text-sm font-medium text-[#1a1a2e] hover:bg-gray-50"
      >
        {action}
      </Link>
    </Card>
  );
}
```

And render, in this exact order:

```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile id="suggestions" label="Suggestions" value={suggestionCount}
              hint="people your agents found" to="/agents" action="View suggestions" />
        <Tile id="pods" label="Pods" value={podCount}
              hint="you belong to" to="/pods" action="Create a pod" />
        <Tile id="circles" label="Circles" value={circleCount}
              hint="you're part of" to="/circles" action="Browse circles" />
        <Tile id="messages" label="Messages" value={unreadCount}
              hint="unread conversations" to="/messages" action="Open messages" />
      </div>
```

- [ ] **Step 6: Demote events and invites to a second row**

Below the grid, keep events and invites but visually secondary, per Claus's "agenda" note:

```tsx
      {/* Second row: an agenda rather than headline metrics. Events will grow
          varied (circle events, 1:1s), so this is a list, not a counter. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="!p-4" data-testid="tile-events">
          <p className="text-sm font-semibold text-[#1a1a2e]">Your agenda</p>
          <p className="mt-0.5 text-xs text-gray-400">
            {upcomingCount === 0 ? 'Nothing scheduled yet' : `${upcomingCount} coming up`}
          </p>
          <Link to="/sessions" className="mt-3 flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 text-sm font-medium hover:bg-gray-50">
            View events
          </Link>
        </Card>
        <Card className="!p-4" data-testid="tile-invites">
          <p className="text-sm font-semibold text-[#1a1a2e]">Invites</p>
          <p className="mt-0.5 text-xs text-gray-400">{inviteCount} sent</p>
          <Link to="/invites" className="mt-3 flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 text-sm font-medium hover:bg-gray-50">
            Invite someone
          </Link>
        </Card>
      </div>
```

Delete the now-duplicated standalone "Invite Someone" action card further down the file. Keep `upcomingCount` and `inviteCount` bound to the variables already computed in the file — read them before writing this step and use the existing names rather than inventing new ones.

- [ ] **Step 7: Run the test and the guard**

```bash
cd client && npx tsc --noEmit
cd .. && node scripts/check-realtime-entities.js
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/wave12-edge-cases.spec.ts -g "leads with Suggestions" --workers=1 --retries=0
```

Expected: typecheck clean, guard OK, test PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/features/home/HomePage.tsx e2e/tests/wave12-edge-cases.spec.ts
git commit -m "Dashboard leads with Suggestions, Pods, Circles, Messages, each tile owning its action"
```

---

### Task A4: New-suggestion badge on the nav, from anywhere

**Files:**
- Modify: `client/src/components/layout/AppLayout.tsx`
- Test: `e2e/tests/wave12-edge-cases.spec.ts`

**Interfaces:**
- Consumes: `GET /agents` → `matchCount` per agent (already exists, already realtime-invalidated by `E.user(userId)`).
- Produces: a `data-testid="nav-suggestions-badge"` element other tests may assert on.

- [ ] **Step 1: Write the failing test**

```typescript
test('a new suggestion shows a badge on the nav from any page', async () => {
  test.setTimeout(300_000);
  const seeker = await createTestUser('edgeBadge');
  const found = await createTestUser('edgeFound');
  await setProfile(found, {
    professional_role: ['Developer'], job_title: 'Senior React Developer',
    expertise_text: 'react typescript',
  });
  const id = await makeAgent(seeker, 'Badge', 'a senior react developer to build my product');
  expect(await countOf(seeker, id)).toBeGreaterThan(0);

  // Land somewhere that is NOT the suggestions page.
  const page = await openAs(seeker, '/messages');
  const badge = page.getByTestId('nav-suggestions-badge');
  await expect(badge).toBeVisible({ timeout: 30_000 });
  await expect(badge).toHaveText(/^[1-9]\d*$/);
  console.log('  ✓ suggestion badge visible from /messages.');

  await cleanup(pool, { ids: [seeker.id, found.id] });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/wave12-edge-cases.spec.ts -g "badge on the nav" --workers=1 --retries=0
```

Expected: FAIL — no such testid.

- [ ] **Step 3: Add the count query and render the badge**

In `AppLayout.tsx`, near the other hooks:

```tsx
  // The badge has to be live from ANY page, so the count is fetched in the
  // layout rather than on the suggestions page. It rides the same entity
  // invalidation as everything else keyed on the user.
  const { data: agentList } = useQuery({
    queryKey: ['agents', false],
    queryFn: () => api.get('/agents').then(r => r.data.data as Array<{ matchCount: number }>),
    enabled: !!user?.id,
    meta: { entities: user?.id ? [E.user(user.id)] : [] },
  });
  const suggestionCount = (agentList ?? []).reduce((n, a) => n + (a.matchCount || 0), 0);
```

Then in the nav item render, where `link.label` is drawn, append:

```tsx
              {link.label === 'Suggestions' && suggestionCount > 0 && (
                <span
                  data-testid="nav-suggestions-badge"
                  className="ml-auto min-w-[20px] rounded-full bg-rsn-red px-1.5 py-0.5 text-center text-[11px] font-bold text-white"
                >
                  {suggestionCount}
                </span>
              )}
```

- [ ] **Step 4: Run the test and the guard**

```bash
cd .. && node scripts/check-realtime-entities.js
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/wave12-edge-cases.spec.ts -g "badge on the nav" --workers=1 --retries=0
```

Expected: guard OK, test PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/layout/AppLayout.tsx e2e/tests/wave12-edge-cases.spec.ts
git commit -m "Suggestion count badges the nav from every page"
```

---

### Task A5: Message view names the sender and shows who they are

The conversation header already links to the profile (`MessagesPage.tsx:726`). What is missing is prominence and any sense of who the person is.

**Files:**
- Modify: `client/src/features/messages/MessagesPage.tsx`
- Modify: `server/src/routes/dm.ts` (include `jobTitle`, `company`, `bio` on the conversation header payload)
- Test: `server/src/__tests__/routes/dm.test.ts`, `e2e/tests/match-accept-ui.spec.ts`

**Interfaces:**
- Consumes: existing `GET /dm/conversations` payload.
- Produces: each conversation object gains `otherJobTitle: string | null`, `otherCompany: string | null`, `otherBio: string | null`. The client reads these; no other task depends on them.

- [ ] **Step 1: Find the conversation query**

```bash
grep -n "otherDisplayName\|other_display_name" server/src/routes/dm.ts server/src/services/dm/*.ts | head
```

Read the SQL that builds the inbox and note its exact alias style — match it rather than inventing a new one.

- [ ] **Step 2: Write the failing server test**

Append to `server/src/__tests__/routes/dm.test.ts`:

```typescript
// 13 Aug: "unclear who's messaging you" — the inbox returned a name and
// nothing else, so a member could not tell a stranger from a colleague.
it('the inbox carries enough to say WHO is writing, not just their name', async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await request(app).get('/dm/conversations').set('Authorization', `Bearer ${token()}`);
  const sql = String(mockQuery.mock.calls[0][0]);
  expect(sql).toMatch(/job_title/);
  expect(sql).toMatch(/company/);
  expect(sql).toMatch(/bio/);
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd server && npx jest --coverage=false src/__tests__/routes/dm.test.ts -t "WHO is writing"
```

Expected: FAIL — the SQL selects no such columns.

- [ ] **Step 4: Add the columns to the query**

In the inbox SQL in `server/src/routes/dm.ts` (or the dm service it delegates to), add to the SELECT list, following the existing alias convention:

```sql
       u.job_title  AS "otherJobTitle",
       u.company    AS "otherCompany",
       LEFT(u.bio, 180) AS "otherBio",
```

`LEFT(...)` keeps the payload small — the message view wants a line, not an essay.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd server && npx jest --coverage=false src/__tests__/routes/dm.test.ts -t "WHO is writing"
```

Expected: PASS.

- [ ] **Step 6: Render it in the header**

In `MessagesPage.tsx`, in the `headerContext` block around line 726, replace the name-only link with:

```tsx
              <Link to={`/profile/${headerContext.otherUserId}`} className="min-w-0 flex-1 hover:opacity-80">
                <p className="truncate text-base font-bold text-[#1a1a2e]">
                  {headerContext.otherDisplayName ?? 'A member'}
                </p>
                {(headerContext.otherJobTitle || headerContext.otherCompany) && (
                  <p className="truncate text-xs text-gray-500">
                    {[headerContext.otherJobTitle, headerContext.otherCompany].filter(Boolean).join(' · ')}
                  </p>
                )}
                {headerContext.otherBio && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-gray-400">{headerContext.otherBio}</p>
                )}
              </Link>
```

Extend the `headerContext` type declaration at the top of the file to carry the three new fields as `string | null`.

- [ ] **Step 7: Add the E2E assertion**

In `e2e/tests/match-accept-ui.spec.ts`, inside the test that accepts a request and opens the conversation, after the conversation opens:

```typescript
  // 13 Aug: the header must say who this person is, not just their name.
  const header = page.getByRole('link', { name: new RegExp(sender.displayName, 'i') });
  await expect(header).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Senior React Developer/i)).toBeVisible();
```

Set that job title on the sender fixture in that spec's `beforeAll` if it is not already set.

- [ ] **Step 8: Full run and commit**

```bash
cd server && npx jest --coverage=false src/__tests__/routes/dm.test.ts
cd ../client && npx tsc --noEmit
cd ../e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/match-accept-ui.spec.ts --workers=1 --retries=0
git add -A server/src client/src e2e
git commit -m "The message view says who is writing to you, not just their name"
```

---

### Task A6: Ship Wave A

- [ ] **Step 1: Full server suite**

```bash
cd server && npx jest --coverage=false 2>&1 | grep -E "^(FAIL|Tests:|Test Suites:)"
```

Expected: `Test Suites: N passed`, no FAIL lines. If one suite fails under parallel load, re-run that suite alone before concluding anything.

- [ ] **Step 2: Client typecheck and realtime guard**

```bash
cd client && npx tsc --noEmit && cd .. && node scripts/check-realtime-entities.js
```

- [ ] **Step 3: Push to staging and wait for CI**

```bash
gh auth switch -u rsnnetwork
git push origin overhaul-truthful-loop:staging
gh run list --branch staging -L 1 --json status,conclusion,headSha
```

Poll until `completed`. Do not proceed on anything but `success`.

- [ ] **Step 4: Ship to main and wait for the deploy**

```bash
git push origin overhaul-truthful-loop:main
```

Wait ~5 minutes, then confirm `https://api.rsn.network/health` returns `status: ok`.

- [ ] **Step 5: Headed production smoke, whole of Waves 1, 2 and A**

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/matching-agents.spec.ts tests/wave12-edge-cases.spec.ts tests/match-accept-ui.spec.ts tests/circle-links.spec.ts tests/onboarding-states.spec.ts --reporter=list --workers=1 --retries=0
```

Expected: every test passes. A failure here is either a real regression or a harness bug — diagnose which before reporting, and never report a wave complete on a red run.

---

# WAVE B — Two things silently steering the matcher

---

### Task B1: LinkedIn-inferred titles stop masquerading as stated ones

`applyEnrichedToProfile` (`server/src/services/onboarding/enrichment.repo.ts:140`) writes `job_title` from LinkedIn-derived data. `job_title` is a **matching input** — `normalizeDesignation` buckets it exactly like a stated role. So a guessed title silently changes who a member matches. Ali's own account carries `professional_role: ['Founder']` with `job_title: 'Web & Software Engineer'`, which is why he appears in developer searches.

**Files:**
- Modify: `server/src/services/onboarding/enrichment.service.ts` (the `PROMPT` at line 188)
- Modify: `server/src/services/onboarding/enrichment.repo.ts` (`applyEnrichedToProfile`)
- Create: `server/src/db/migrations/088_job_title_provenance.sql`
- Test: `server/src/__tests__/services/onboarding/enrichment-provenance.test.ts` (new)

**Interfaces:**
- Consumes: `ApplyFields` (existing shape in `enrichment.repo.ts`).
- Produces: `users.job_title_source TEXT` with values `'stated'` or `'inferred'` (nullable, default NULL for existing rows). `applyEnrichedToProfile` gains no new parameter — it always writes `'inferred'`; the onboarding confirm path writes `'stated'`.

- [ ] **Step 1: Write the migration**

Create `server/src/db/migrations/088_job_title_provenance.sql`:

```sql
-- 13 Aug 2026: the enrichment step writes users.job_title from what it inferred
-- about a LinkedIn profile, and job_title is a MATCHING INPUT — the taxonomy
-- buckets it exactly like a role the member stated. A guessed title therefore
-- changes who someone matches, invisibly. Record where the title came from so
-- the matcher can weigh it accordingly and the UI can show it as a suggestion.
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title_source TEXT
  CHECK (job_title_source IN ('stated', 'inferred'));

-- Everything written before today came through a path that did not distinguish
-- the two, so it stays NULL rather than claiming a provenance we do not know.
COMMENT ON COLUMN users.job_title_source IS
  'stated = the member typed or confirmed it; inferred = enrichment guessed it; NULL = unknown (pre-088)';
```

- [ ] **Step 2: Write the failing tests**

Create `server/src/__tests__/services/onboarding/enrichment-provenance.test.ts`:

```typescript
// ─── Where a job title came from (13 Aug 2026) ───────────────────────────────
//
// Stefan: "Bot pulls role/title from LinkedIn even when not explicitly set on
// the profile — needs a prompt fix so it doesn't misattribute roles."
//
// The prompt fix is half of it. The other half is that job_title feeds the
// MATCHER, so a guess does not just look wrong on a profile, it changes who a
// member is introduced to.

const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { applyEnrichedToProfile } from '../../../services/onboarding/enrichment.repo';
import * as fs from 'fs';
import * as path from 'path';

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [] }); });

describe('an enriched title is marked as inferred', () => {
  it('records provenance when enrichment writes a title', async () => {
    await applyEnrichedToProfile('u-1', { jobTitle: 'Head of Growth' } as any);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/job_title_source/);
    expect(sql).toMatch(/'inferred'/);
  });

  it('does not stamp provenance when no title was inferred', async () => {
    await applyEnrichedToProfile('u-1', { company: 'Acme' } as any);
    const sql = String(mockQuery.mock.calls[0][0]);
    // COALESCE guards it: a null title must leave both column and source alone.
    expect(sql).toMatch(/COALESCE/);
  });
});

describe('the enrichment prompt refuses to invent a role', () => {
  const prompt = fs.readFileSync(
    path.join(__dirname, '../../../services/onboarding/enrichment.service.ts'), 'utf8');

  it('tells the model to return nothing rather than guess a title', () => {
    expect(prompt).toMatch(/only if it is stated/i);
    expect(prompt).toMatch(/null/i);
  });

  it('forbids deriving a title from company or activity', () => {
    expect(prompt).toMatch(/do not infer/i);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd server && npx jest --coverage=false src/__tests__/services/onboarding/enrichment-provenance.test.ts
```

Expected: FAIL on all four.

- [ ] **Step 4: Stamp provenance in the repo**

In `server/src/services/onboarding/enrichment.repo.ts`, replace the UPDATE:

```typescript
export async function applyEnrichedToProfile(userId: string, f: ApplyFields): Promise<void> {
  await query(
    `UPDATE users SET
       job_title    = COALESCE($2, job_title),
       -- Only claim provenance when we actually wrote a title. job_title feeds
       -- the matcher, so an inferred one must be distinguishable from a stated
       -- one rather than silently steering introductions.
       job_title_source = CASE WHEN $2::text IS NULL THEN job_title_source ELSE 'inferred' END,
       company      = COALESCE($3, company),
       industry     = COALESCE($4, industry),
       location     = COALESCE($5, location),
       bio          = COALESCE($6, bio),
       linkedin_url = COALESCE($7, linkedin_url),
       updated_at   = NOW()
     WHERE id = $1`,
    [userId, f.jobTitle ?? null, f.company ?? null, f.industry ?? null, f.location ?? null, f.bio ?? null, f.linkedin ?? null],
  );
}
```

- [ ] **Step 5: Tighten the enrichment prompt**

In `server/src/services/onboarding/enrichment.service.ts`, inside the `PROMPT` template, add these rules to the instruction block:

```
RULES ON ROLE AND TITLE — read carefully:
- Return jobTitle ONLY if it is stated outright on the profile or in a source
  you found. If it is not stated, return null.
- Do NOT infer a title from the company, the industry, the person's posts, or
  what they seem to do. "Works at a design studio" is not "Designer".
  "Founded a company" is not "CEO". A null title is correct and useful; a
  guessed one is worse than nothing, because the platform matches on it.
- If several titles appear, choose the one the person uses for themselves, not
  the most senior-sounding one.
```

- [ ] **Step 6: Run to verify they pass**

```bash
cd server && npx jest --coverage=false src/__tests__/services/onboarding/enrichment-provenance.test.ts
```

Expected: PASS on all four.

- [ ] **Step 7: Weigh inferred titles lower in the matcher**

In `server/src/services/matching/platform-match.service.ts`, `analyzeWants` builds `titleByDesignation` from `professionalRole` values and `jobTitle`. A stated role must beat an inferred title. Add `jobTitleSource` to `IntentProfile`, select it in the candidate queries (`CANDIDATE_COLUMNS` in `agent-matching.service.ts` and `loadCandidates` in `platform-match.service.ts` — both need `u.job_title_source AS "jobTitleSource"`), and order the sources so a stated role wins the naming race:

```typescript
  // Stated roles first, then the job title — and an INFERRED job title last, so
  // a guess never becomes the reason we give a member for an introduction.
  const stated = Array.isArray(other.professionalRole)
    ? other.professionalRole
    : [flatten(other.professionalRole)];
  const ordered = other.jobTitleSource === 'inferred'
    ? [...stated, other.jobTitle]
    : [other.jobTitle, ...stated];
  for (const r of ordered) { /* existing titleByDesignation loop body */ }
```

- [ ] **Step 8: Add the matcher test**

Append to `server/src/__tests__/services/matching/want-precision.test.ts`:

```typescript
describe('a stated role outranks an inferred title', () => {
  it('names the stated role in the reason, not the guess', () => {
    const p = profile({
      id: 'u-x', displayName: 'Sam',
      professionalRole: ['Investor'], jobTitle: 'Head of Growth',
      jobTitleSource: 'inferred',
    } as any);
    const { reason } = scoreWants(['investors and growth marketers'], p);
    expect(reason).toMatch(/Investor/);
  });
});
```

- [ ] **Step 9: Full suite and commit**

```bash
cd server && npx tsc --noEmit && npx jest --coverage=false 2>&1 | grep -E "^(FAIL|Tests:)"
git add -A server/src
git commit -m "An inferred job title is recorded as inferred, and never outranks a stated role"
```

---

### Task B2: Onboarding creates the member's first agent

Nothing creates an agent at the end of onboarding. Build it at the completion point: `server/src/routes/onboarding.ts:434`, immediately after `saveIntentAndComplete` returns.

**Files:**
- Create: `server/src/services/matching/first-agent.service.ts`
- Modify: `server/src/routes/onboarding.ts` (around line 434)
- Modify: `client/src/features/onboarding/ChatbotOnboarding.tsx` (closing message)
- Test: `server/src/__tests__/services/matching/first-agent.test.ts` (new), `e2e/tests/onboarding-states.spec.ts`

**Interfaces:**
- Consumes: `ExtractedIntent` (from `server/src/services/onboarding/intent.schema.ts`), `agentRepo.createAgent(userId, { label, wantText, matchingTags })`, `designationsWanted(text)` from `intent-signals.ts`, `recomputeAgent(agent)` from `agent-matching.service.ts`.
- Produces: `createFirstAgent(userId: string, intent: ExtractedIntent): Promise<MatchingAgent | null>` — returns the created agent, or `null` when the member said nothing searchable. Never throws.

- [ ] **Step 1: Read the intent shape**

```bash
sed -n '1,80p' server/src/services/onboarding/intent.schema.ts
```

Note the exact field names for who they want to meet. The plan below uses `whoIWantToMeet` and `reasonForMeeting`; if the schema calls them something else, use the schema's names throughout.

- [ ] **Step 2: Write the failing tests**

Create `server/src/__tests__/services/matching/first-agent.test.ts`:

```typescript
// ─── The first agent, made at the end of onboarding (13 Aug 2026) ────────────
//
// Stefan: "First agent isn't auto-creating after onboarding as it should."
// It never was: migration 087 seeded agents for members who already existed,
// and nothing on the onboarding path creates one. A member who finishes the
// chat today lands on an empty Suggestions page having just described, in
// detail, exactly who they want to meet.

const mockCreate = jest.fn<any, any[]>();
const mockRecompute = jest.fn<any, any[]>();

jest.mock('../../../services/matching/agent.repo', () => ({
  createAgent: (...a: unknown[]) => mockCreate(...a),
  __esModule: true,
}));
jest.mock('../../../services/matching/agent-matching.service', () => ({
  recomputeAgent: (...a: unknown[]) => mockRecompute(...a),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { createFirstAgent } from '../../../services/matching/first-agent.service';

const intent = (over: Record<string, unknown> = {}) => ({
  whoIWantToMeet: 'react developers who can build my product',
  reasonForMeeting: 'I need help shipping',
  matchingTags: ['react', 'product'],
  ...over,
}) as any;

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ id: 'a-1', userId: 'u-1', label: 'Developers and engineers', wantText: 'x' });
  mockRecompute.mockReset(); mockRecompute.mockResolvedValue(2);
});

describe('createFirstAgent', () => {
  it('creates one agent from what the member said they want', async () => {
    const a = await createFirstAgent('u-1', intent());
    expect(a).not.toBeNull();
    const [userId, input] = mockCreate.mock.calls[0];
    expect(userId).toBe('u-1');
    expect(input.wantText).toBe('react developers who can build my product');
  });

  it('names it after the role they asked for, not a generic label', async () => {
    await createFirstAgent('u-1', intent());
    const [, input] = mockCreate.mock.calls[0];
    expect(input.label).toMatch(/developers and engineers/i);
  });

  it('falls back to a generic label when no role is named', async () => {
    await createFirstAgent('u-1', intent({ whoIWantToMeet: 'interesting people' }));
    const [, input] = mockCreate.mock.calls[0];
    expect(input.label).toBe('People I want to meet');
  });

  it('searches immediately, so the member does not land on an empty page', async () => {
    await createFirstAgent('u-1', intent());
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  it('creates nothing when the member said nothing searchable', async () => {
    const a = await createFirstAgent('u-1', intent({ whoIWantToMeet: '   ', reasonForMeeting: '' }));
    expect(a).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('never throws — it runs off the onboarding completion path', async () => {
    mockCreate.mockRejectedValueOnce(new Error('db down'));
    await expect(createFirstAgent('u-1', intent())).resolves.toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd server && npx jest --coverage=false src/__tests__/services/matching/first-agent.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the service**

Create `server/src/services/matching/first-agent.service.ts`:

```typescript
// ─── The member's first matching agent (13 Aug 2026) ─────────────────────────
//
// A member finishes the onboarding chat having described exactly who they want
// to meet, and then lands on an empty Suggestions page. Migration 087 seeded
// agents for members who already existed; nothing ever created one for someone
// new. This closes that gap at the moment the intent is captured.

import * as agentRepo from './agent.repo';
import { recomputeAgent } from './agent-matching.service';
import { designationsWanted } from './intent-signals';
import logger from '../../config/logger';
import type { MatchingAgent } from './agent.repo';

const GENERIC_LABEL = 'People I want to meet';

/** Title-case a taxonomy label: "developers and engineers" → "Developers and engineers". */
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Build one agent from the onboarding intent. Returns null when there is
 * nothing searchable to build from — an empty agent would sit at zero forever
 * and teach the member that the feature does not work.
 *
 * Never throws: this runs on the completion path, and a failure here must not
 * cost the member the onboarding they just finished.
 */
export async function createFirstAgent(
  userId: string,
  intent: { whoIWantToMeet?: string | null; reasonForMeeting?: string | null; matchingTags?: string[] },
): Promise<MatchingAgent | null> {
  try {
    const wantText = (intent.whoIWantToMeet || '').trim() || (intent.reasonForMeeting || '').trim();
    if (!wantText) return null;

    // Name it after the role they actually asked for, using the SAME taxonomy
    // the matcher searches with — a label that disagrees with the search is
    // how "Marketing people" ended up on a search for executives.
    const hits = designationsWanted(wantText);
    const label = hits.length === 1 ? title(hits[0].label) : GENERIC_LABEL;

    const agent = await agentRepo.createAgent(userId, {
      label,
      wantText,
      matchingTags: intent.matchingTags ?? [],
    });

    // Score it now. Inserting a row runs no search — that is exactly why the
    // 087-seeded agents all read "0 potential matches" on 3 Aug.
    await recomputeAgent(agent).catch(err =>
      logger.warn({ err, agentId: agent.id }, 'first agent scored later'));

    return agent;
  } catch (err) {
    logger.error({ err, userId }, 'could not create first agent');
    return null;
  }
}
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd server && npx jest --coverage=false src/__tests__/services/matching/first-agent.test.ts
```

Expected: PASS on all six.

- [ ] **Step 6: Call it from the completion path**

In `server/src/routes/onboarding.ts`, immediately after the `saveIntentAndComplete` call at line ~434 and before the response is sent:

```typescript
      // Give them the agent their answers describe, and search it now, so the
      // Suggestions page has something on it the first time they open it.
      const firstAgent = await createFirstAgent(userId, intent);
```

And include it in the response so the client can name it:

```typescript
      const response: ApiResponse = {
        success: true,
        data: {
          summary: intent.userProfileSummary,
          profileComplete,
          firstAgent: firstAgent ? { id: firstAgent.id, label: firstAgent.label } : null,
        },
      };
```

Add the import at the top of the file:

```typescript
import { createFirstAgent } from '../services/matching/first-agent.service';
```

- [ ] **Step 7: Close the chat on the agent**

In `client/src/features/onboarding/ChatbotOnboarding.tsx`, where the completion response is handled, use the returned agent:

```tsx
        // The chat ends on something concrete the member can go and look at,
        // rather than a summary they cannot act on.
        if (data.firstAgent) {
          setClosingMessage(
            `I have set up your first agent, ${data.firstAgent.label}, and it is searching now. ` +
            `Who else would you like to meet?`
          );
        }
```

Read the surrounding component before writing this — use the state setter and message-append pattern the file already uses rather than introducing a new one.

- [ ] **Step 8: Write the E2E**

Append to `e2e/tests/onboarding-states.spec.ts`:

```typescript
test('finishing onboarding leaves the member with a first agent that has searched', async () => {
  test.setTimeout(300_000);
  const fresh = await createTestUser('obFirstAgent');
  await pool.query(
    `UPDATE users SET onboarding_completed = false, onboarding_status = 'not_started' WHERE id = $1`,
    [fresh.id]);

  // Drive the completion endpoint the way the client does.
  const res = await apiAs(fresh, 'POST', '/onboarding/chat/complete', {
    messages: [
      { role: 'assistant', content: 'What brings you to Reason?' },
      { role: 'user', content: 'I am looking for react developers who can build my product.' },
    ],
  });
  expect(res.status, 'completion accepted').toBeLessThan(300);

  const agents = await pool.query(
    `SELECT id, label, want_text, last_matched_at FROM matching_agents WHERE user_id = $1`, [fresh.id]);
  expect(agents.rows.length, 'exactly one first agent').toBe(1);
  expect(agents.rows[0].want_text, 'built from what they said').toMatch(/react/i);
  expect(agents.rows[0].last_matched_at, 'and it has actually searched').not.toBeNull();

  // And it is on the page, not just in the database — the 3 Aug lesson.
  const page = await openAs(fresh, '/agents');
  await expect(page.getByTestId(`agent-${agents.rows[0].id}`)).toBeVisible({ timeout: 30_000 });

  await cleanup(pool, { ids: [fresh.id] });
});
```

Before writing this, confirm the completion endpoint's real path and body shape by reading `server/src/routes/onboarding.ts` around line 400 — use whatever it actually is.

- [ ] **Step 9: Full suite and commit**

```bash
cd server && npx tsc --noEmit && npx jest --coverage=false 2>&1 | grep -E "^(FAIL|Tests:)"
cd ../client && npx tsc --noEmit
git add -A server/src client/src e2e
git commit -m "Onboarding ends on a first agent that has already searched"
```

---

### Task B3: Ship Wave B

- [ ] **Step 1: Confirm the migration will run**

```bash
grep -n "088" server/src/db/migrations/*.sql | head
```

Migrations auto-run on boot. Confirm 088 is the only new file and that it is idempotent (`IF NOT EXISTS`).

- [ ] **Step 2: Same ship sequence as Task A6**

Full server suite → client typecheck → realtime guard → staging → CI green → main → wait for deploy → headed prod smoke of all five spec files.

- [ ] **Step 3: Backfill provenance for existing members**

After the deploy, existing rows have `job_title_source = NULL`. Every title written by enrichment before today was inferred, but we cannot distinguish those from stated ones retrospectively, and guessing would recreate the bug in the other direction. Leave them NULL. The matcher treats NULL as "not inferred", i.e. it keeps today's behaviour for existing members and only improves for new ones.

Record this explicitly in the report to Ali — it is a deliberate limitation, not an oversight.

---

# WAVE C — New capability

---

### Task C1: Platform-wide people search

Today `/users/connected?q=` searches only people you have already met, and the "People" nav points at `/encounters`. Claus could not find himself on the platform. Per the recorded decision: all active onboarded members are findable; results show name, title, company and photo plus "I want to meet"; full profile and messaging keep their existing gates.

**Files:**
- Modify: `server/src/routes/users.ts` (new route)
- Create: `server/src/services/user/user-search.service.ts`
- Create: `client/src/features/search/SearchPage.tsx`
- Modify: `client/src/App.tsx` (route), `client/src/components/layout/AppLayout.tsx` (nav entry)
- Create: `server/src/db/migrations/089_user_search_index.sql`
- Test: `server/src/__tests__/services/user/user-search.test.ts` (new), `e2e/tests/search.spec.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /users/search?q=<string>&limit=<n>` → `{ success: true, data: SearchResult[] }` where
  `SearchResult = { userId: string; displayName: string | null; avatarUrl: string | null; jobTitle: string | null; company: string | null; location: string | null }`.
  And `searchMembers(viewerId: string, q: string, limit: number): Promise<SearchResult[]>`.

- [ ] **Step 1: Write the migration**

Create `server/src/db/migrations/089_user_search_index.sql`:

```sql
-- 13 Aug 2026: platform-wide people search. Claus could not find himself on the
-- platform — the only search that existed was over people you had already met.
-- Trigram indexes so ILIKE '%claus%' does not table-scan as the network grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm
  ON users USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_job_title_trgm
  ON users USING gin (job_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_company_trgm
  ON users USING gin (company gin_trgm_ops);
```

- [ ] **Step 2: Write the failing service tests**

Create `server/src/__tests__/services/user/user-search.test.ts`:

```typescript
// ─── Platform-wide people search (13 Aug 2026) ───────────────────────────────
//
// Claus: "No way to search for a known person on the platform." The only
// search that existed was /users/connected, over people you had ALREADY met —
// useless for finding someone you have not.

const mockQuery = jest.fn<any, any[]>();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { searchMembers } from '../../../services/user/user-search.service';

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [] }); });

describe('searchMembers', () => {
  it('searches name, title and company', async () => {
    await searchMembers('me', 'claus', 20);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/display_name ILIKE/);
    expect(sql).toMatch(/job_title ILIKE/);
    expect(sql).toMatch(/company ILIKE/);
  });

  it('only ever returns active, onboarded members', async () => {
    await searchMembers('me', 'claus', 20);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/u\.status = 'active'/);
    expect(sql).toMatch(/onboarding_completed = true/);
  });

  it('never returns the searcher, or anyone in a block relationship either way', async () => {
    await searchMembers('me', 'claus', 20);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/u\.id <> \$1/);
    expect(sql).toMatch(/user_blocks/);
    expect(sql).toMatch(/blocker_id = \$1/);
    expect(sql).toMatch(/blocked_id = \$1/);
  });

  it('caps the result set however large a limit is asked for', async () => {
    await searchMembers('me', 'claus', 5000);
    const params = mockQuery.mock.calls[0][1];
    expect(params[2]).toBeLessThanOrEqual(50);
  });

  it('returns nothing for a blank or one-character query, without hitting the db', async () => {
    expect(await searchMembers('me', '', 20)).toEqual([]);
    expect(await searchMembers('me', 'c', 20)).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not leak bio, email or LinkedIn in a search result', async () => {
    await searchMembers('me', 'claus', 20);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).not.toMatch(/u\.email/);
    expect(sql).not.toMatch(/u\.bio/);
    expect(sql).not.toMatch(/linkedin_url/);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd server && npx jest --coverage=false src/__tests__/services/user/user-search.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the service**

Create `server/src/services/user/user-search.service.ts`:

```typescript
// ─── Platform-wide people search (13 Aug 2026) ───────────────────────────────
//
// The only search on the platform was /users/connected, over people you had
// already met — so a member could not find someone they had come here to find.
// This is deliberately a THIN result: name, title, company, photo. Everything
// else stays behind the gates it already sits behind; being findable is not the
// same as being open.

import { query } from '../../db';

export interface SearchResult {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
}

const MAX_LIMIT = 50;
const MIN_QUERY = 2;

export async function searchMembers(
  viewerId: string,
  q: string,
  limit: number,
): Promise<SearchResult[]> {
  const term = (q || '').trim();
  // One character matches most of the network — that is a scrape, not a search.
  if (term.length < MIN_QUERY) return [];
  const capped = Math.min(Math.max(1, limit || 20), MAX_LIMIT);

  const r = await query<SearchResult>(
    `SELECT u.id AS "userId", u.display_name AS "displayName",
            u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle",
            u.company, u.location
       FROM users u
      WHERE u.id <> $1
        AND u.status = 'active'
        AND u.onboarding_completed = true
        AND (u.display_name ILIKE $2 OR u.job_title ILIKE $2 OR u.company ILIKE $2)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1))
      ORDER BY
        -- A name match is what someone searching for "Claus" means; title and
        -- company matches come after it.
        (u.display_name ILIKE $2) DESC,
        u.display_name ASC
      LIMIT $3`,
    [viewerId, `%${term}%`, capped],
  );
  return r.rows;
}
```

- [ ] **Step 5: Run to verify they pass**

```bash
cd server && npx jest --coverage=false src/__tests__/services/user/user-search.test.ts
```

Expected: PASS on all six.

- [ ] **Step 6: Add the route**

In `server/src/routes/users.ts`, near the existing `/connected` route:

```typescript
// GET /users/search — find anyone on the platform by name, title or company.
// Distinct from /connected, which only searches people you have already met.
router.get(
  '/search',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = (req.query.q as string || '').trim();
      const limit = parseInt(String(req.query.limit || '20'), 10) || 20;
      const data = await searchMembers(req.user!.userId, q, limit);
      res.json({ success: true, data } as ApiResponse);
    } catch (err) { next(err); }
  }
);
```

Import `searchMembers` at the top. **Register it before any `/:id` route in the same file**, or Express will treat `search` as an id.

- [ ] **Step 7: Write the failing E2E**

Create `e2e/tests/search.spec.ts` following the structure of `wave12-edge-cases.spec.ts` (same imports, same `openAs`/`apiAs`/`setProfile` helpers — copy them, the specs are deliberately self-contained). Tests:

```typescript
test('a member can find someone they have never met, by name', async () => {
  test.setTimeout(240_000);
  const page = await openAs(seeker, '/search');
  await page.getByPlaceholder(/Search people/i).fill(stranger.displayName);
  const card = page.getByTestId(`search-result-${stranger.id}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Senior React Developer');
  console.log('  ✓ found a stranger by name.');
});

test('search finds by job title and by company too', async () => {
  test.setTimeout(240_000);
  const page = await openAs(seeker, '/search');
  await page.getByPlaceholder(/Search people/i).fill('Senior React Developer');
  await expect(page.getByTestId(`search-result-${stranger.id}`)).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder(/Search people/i).fill('TestCo');
  await expect(page.getByTestId(`search-result-${stranger.id}`)).toBeVisible({ timeout: 30_000 });
});

test('search never returns you, a blocked member, or a deactivated one', async () => {
  test.setTimeout(300_000);
  const r1 = await apiAs(seeker, 'GET', `/users/search?q=${encodeURIComponent(seeker.displayName)}`);
  expect(r1.json.data.map((x: any) => x.userId)).not.toContain(seeker.id);

  await apiAs(seeker, 'POST', `/users/${blocked.id}/block`);
  const r2 = await apiAs(seeker, 'GET', `/users/search?q=${encodeURIComponent(blocked.displayName)}`);
  expect(r2.json.data.map((x: any) => x.userId), 'blocked stays hidden').not.toContain(blocked.id);

  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [gone.id]);
  const r3 = await apiAs(seeker, 'GET', `/users/search?q=${encodeURIComponent(gone.displayName)}`);
  expect(r3.json.data.map((x: any) => x.userId), 'deactivated stays hidden').not.toContain(gone.id);
});

test('a one-character query returns nothing rather than the whole network', async () => {
  const r = await apiAs(seeker, 'GET', '/users/search?q=a');
  expect(r.json.data).toEqual([]);
});

test('a search result offers a way to meet, and does not leak the full profile', async () => {
  test.setTimeout(240_000);
  const page = await openAs(seeker, '/search');
  await page.getByPlaceholder(/Search people/i).fill(stranger.displayName);
  const card = page.getByTestId(`search-result-${stranger.id}`);
  await expect(card.getByRole('button', { name: /I want to meet/i })).toBeVisible({ timeout: 30_000 });
  // The thin card carries no bio and no email.
  await expect(card).not.toContainText('@');
});

test('the search page fits a phone', async () => {
  const page = await openAs(seeker, '/search', { width: 360, height: 780 });
  await page.getByPlaceholder(/Search people/i).fill(stranger.displayName);
  await expect(page.getByTestId(`search-result-${stranger.id}`)).toBeVisible({ timeout: 30_000 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
```

- [ ] **Step 8: Build the page**

Create `client/src/features/search/SearchPage.tsx`:

```tsx
// Platform-wide people search (13 Aug 2026).
//
// The result card is deliberately thin — name, title, company, photo — and its
// only action is the introduction path that already exists. Being findable is
// not the same as being open: bio, contact details and messaging keep the gates
// they had before.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface Result {
  userId: string; displayName: string | null; avatarUrl: string | null;
  jobTitle: string | null; company: string | null; location: string | null;
}

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const addToast = useToastStore(s => s.addToast);

  // realtime: skip — a search is a point-in-time query, not a live view
  const { data: results, isFetching } = useQuery({
    queryKey: ['user-search', q],
    queryFn: () => api.get(`/users/search?q=${encodeURIComponent(q)}`).then(r => r.data.data as Result[]),
    enabled: q.trim().length >= 2,
  });

  const meet = useMutation({
    mutationFn: (userId: string) => api.post(`/matches/platform/${userId}/interest`),
    onSuccess: (_d, userId) => {
      setAsked(prev => new Set(prev).add(userId));
      addToast('Meeting request sent', 'success');
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Could not send that', 'error'),
  });

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="font-display text-2xl font-bold text-[#1a1a2e]">Find someone</h1>
      <p className="mt-1 text-sm text-gray-500">Search by name, job title or company.</p>

      <div className="relative mt-4">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search people..."
          aria-label="Search people"
          autoFocus
          className="min-h-[44px] w-full rounded-lg border-2 border-gray-300 pl-9 pr-3 text-base focus:border-rsn-red focus:outline-none"
        />
      </div>

      {q.trim().length >= 2 && !isFetching && (results ?? []).length === 0 && (
        <Card className="mt-4 !p-8 text-center text-sm text-gray-500">
          Nobody on Reason matches “{q.trim()}”.
        </Card>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {(results ?? []).map(r => (
          <Card key={r.userId} className="!p-4" data-testid={`search-result-${r.userId}`}>
            <div className="flex items-start gap-3">
              <Avatar src={r.avatarUrl || undefined} name={r.displayName || 'Member'} size="md" />
              <div className="min-w-0 flex-1">
                <Link to={`/profile/${r.userId}`} className="truncate text-sm font-semibold text-[#1a1a2e] hover:underline">
                  {r.displayName || 'A member'}
                </Link>
                <p className="truncate text-xs text-gray-500">
                  {[r.jobTitle, r.company].filter(Boolean).join(' · ')}
                </p>
                {r.location && <p className="truncate text-xs text-gray-400">{r.location}</p>}
              </div>
            </div>
            <Button
              onClick={() => meet.mutate(r.userId)}
              disabled={asked.has(r.userId) || meet.isPending}
              className="mt-3 min-h-[44px] w-full justify-center"
            >
              {asked.has(r.userId) ? 'Meeting request sent' : 'I want to meet'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Wire the route and the nav**

In `client/src/App.tsx`, add the lazy route alongside the others:

```tsx
const SearchPage = lazy(() => import('./features/search/SearchPage'));
// ...
<Route path="/search" element={<SearchPage />} />
```

In `AppLayout.tsx`, add a nav item after Suggestions:

```tsx
    { to: '/search', icon: Search, label: 'Find people' },
```

Import `Search` from `lucide-react` (it is already imported as `SearchIcon` in some files — in this file import it under whatever name does not collide).

- [ ] **Step 10: Run everything and commit**

```bash
cd server && npx tsc --noEmit && npx jest --coverage=false src/__tests__/services/user/
cd ../client && npx tsc --noEmit
cd .. && node scripts/check-realtime-entities.js
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/search.spec.ts --workers=1 --retries=0
git add -A server/src client/src e2e
git commit -m "Platform-wide people search"
```

---

### Task C2: Any member can invite

Recorded decision: direct and unlimited, exactly as an admin invite works today. Ali was shown the abuse trade-off and chose this.

**Files:**
- Modify: `server/src/routes/invites.ts` (the four `isAdmin` gates at ~141, ~172, ~205, ~299)
- Modify: `client/src/features/invites/InvitesPage.tsx` (remove admin-only affordances)
- Test: `server/src/__tests__/routes/invites.test.ts`, `e2e/tests/search.spec.ts` (append) or a new `e2e/tests/member-invites.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature changes. `POST /invites` accepts a `member` role caller.

- [ ] **Step 1: Read all four gates**

```bash
grep -n "isAdmin" -B 8 -A 12 server/src/routes/invites.ts
```

Understand what each one guards. Some are almost certainly about *viewing other people's* invites or reminders, not about creating one — those must stay. Only creation opens up. Write down which line numbers you are changing and why before touching anything.

- [ ] **Step 2: Write the failing tests**

Append to `server/src/__tests__/routes/invites.test.ts`:

```typescript
// 13 Aug: Stefan wants any member to be able to invite. Ali's decision was
// direct and unlimited — a member invite behaves exactly like an admin one.
describe('members can invite', () => {
  it('a member may create an invite', async () => {
    mockCreateInvite.mockResolvedValue({ id: 'i-1', code: 'ABC123' });
    const res = await request(app).post('/invites')
      .set('Authorization', `Bearer ${memberToken()}`)
      .send({ email: 'someone@example.com' });
    expect(res.status).toBe(201);
  });

  it('the invite records who sent it, so origin stays traceable', async () => {
    mockCreateInvite.mockResolvedValue({ id: 'i-1', code: 'ABC123' });
    await request(app).post('/invites')
      .set('Authorization', `Bearer ${memberToken()}`)
      .send({ email: 'someone@example.com' });
    const [createdBy] = mockCreateInvite.mock.calls[0];
    expect(createdBy).toBe('u-member');
  });

  it('a member still cannot see invites they did not send', async () => {
    const res = await request(app).get('/invites?all=1')
      .set('Authorization', `Bearer ${memberToken()}`);
    // Whatever the endpoint does for admins, a member gets only their own.
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      for (const inv of res.body.data ?? []) expect(inv.createdBy).toBe('u-member');
    }
  });
});
```

Add a `memberToken()` helper beside the existing token helper in that file, signing `role: 'member'`, `sub: 'u-member'`.

- [ ] **Step 3: Run to verify they fail**

```bash
cd server && npx jest --coverage=false src/__tests__/routes/invites.test.ts -t "members can invite"
```

Expected: the first two FAIL with 403.

- [ ] **Step 4: Open the creation gate only**

At the creation route (~line 141), replace the admin check with a comment explaining the decision:

```typescript
      // 13 Aug 2026: any member may invite, with the same effect an admin
      // invite has — Ali's explicit decision, taken over the alternative of
      // routing member invites through admin approval. No quota, no per-member
      // rate limit. The audit entry below is what keeps origin traceable.
```

Leave the listing/reminder gates alone unless the test above proves otherwise.

- [ ] **Step 5: Keep the audit trail**

Confirm the creation path writes an `audit_log` row with the actor. If it does not, add one following the pattern used elsewhere in the file. Traceability is not a limit — it is how an abused invite gets traced back.

- [ ] **Step 6: Update the client**

In `client/src/features/invites/InvitesPage.tsx`, remove any `isAdmin` condition that hides the invite form from members. Search for it:

```bash
grep -n "isAdmin\|role" client/src/features/invites/InvitesPage.tsx | head
```

- [ ] **Step 7: Write the E2E**

Create `e2e/tests/member-invites.spec.ts` with a member (not admin) fixture:

```typescript
test('a plain member can create an invite and it works', async () => {
  test.setTimeout(240_000);
  const page = await openAs(member, '/invites');
  await page.getByPlaceholder(/email/i).first().fill('someone-new@example.com');
  await page.getByRole('button', { name: /Send invite|Create invite/i }).first().click();

  const row = await pool.query(
    `SELECT code, created_by FROM invites WHERE created_by = $1 ORDER BY created_at DESC LIMIT 1`,
    [member.id]);
  expect(row.rows.length, 'a real invite row, created by the member').toBe(1);

  // And the code actually resolves.
  const res = await fetch(`${SERVER}/api/invites/${row.rows[0].code}`);
  expect(res.status).toBe(200);
  console.log('  ✓ member-created invite exists and resolves.');

  await pool.query(`DELETE FROM invites WHERE created_by = $1`, [member.id]);
});
```

Check the real table and column names first (`invites` vs `platform_invites`, `created_by` vs `inviter_id`) with a quick `grep -n "INSERT INTO" server/src/services/invite/*.ts`.

- [ ] **Step 8: Run and commit**

```bash
cd server && npx jest --coverage=false src/__tests__/routes/invites.test.ts
cd ../e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/member-invites.spec.ts --workers=1 --retries=0
git add -A server/src client/src e2e
git commit -m "Any member can invite, with the same effect an admin invite has"
```

---

### Task C3: Circle-level invites

Pods have invites; circles do not. `server/src/routes/circles.ts` contains no invite endpoints.

**Files:**
- Modify: `server/src/routes/circles.ts`
- Modify: `server/src/services/circle/circle.service.ts` (confirm the real path first)
- Modify: `client/src/features/circles/CircleDetailPage.tsx` (confirm the real filename first)
- Test: `server/src/__tests__/routes/circles.test.ts`, `e2e/tests/circle-links.spec.ts` (append)

**Interfaces:**
- Consumes: the pod invite implementation as the pattern — read `server/src/routes/invites.ts` `/pod/:podId` and mirror it.
- Produces: `POST /circles/:id/invites` with body `{ email?: string; userId?: string }` → `{ success: true, data: { id, code } }`, and `GET /circles/:id/invites` → the circle's outstanding invites.

- [ ] **Step 1: Read the pod invite path end to end**

```bash
grep -rn "podId" server/src/routes/invites.ts | head -20
grep -rn "pod" server/src/services/invite/*.ts | head -20
```

Mirror its shape exactly — same table, same code generation, same email template, with a circle id instead of a pod id. Do not invent a parallel mechanism.

- [ ] **Step 2: Write the failing tests**

Append to `server/src/__tests__/routes/circles.test.ts`:

```typescript
// 13 Aug: "Circle-level invites also needed, not just pod-level."
describe('circle invites', () => {
  it('a circle member can invite someone to the circle', async () => {
    mockIsMember.mockResolvedValue(true);
    mockCreateCircleInvite.mockResolvedValue({ id: 'ci-1', code: 'XYZ789' });
    const res = await request(app).post('/circles/c-1/invites')
      .set('Authorization', `Bearer ${token()}`).send({ email: 'x@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('XYZ789');
  });

  it('someone who is not in the circle cannot invite to it', async () => {
    mockIsMember.mockResolvedValue(false);
    const res = await request(app).post('/circles/c-1/invites')
      .set('Authorization', `Bearer ${token()}`).send({ email: 'x@example.com' });
    expect(res.status).toBe(403);
  });

  it('rejects a request with neither an email nor a member', async () => {
    mockIsMember.mockResolvedValue(true);
    const res = await request(app).post('/circles/c-1/invites')
      .set('Authorization', `Bearer ${token()}`).send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify they fail, implement, run to verify they pass**

```bash
cd server && npx jest --coverage=false src/__tests__/routes/circles.test.ts -t "circle invites"
```

Implement the route mirroring the pod path, then re-run. Membership is the gate: you must be in a circle to invite to it.

- [ ] **Step 4: Add the client button**

On the circle detail page, add an "Invite to this circle" action that posts to the new endpoint, using the same modal/inline pattern the pod page uses. Read the pod page first and copy its interaction rather than designing a new one.

- [ ] **Step 5: E2E and commit**

Add a test that a circle member creates an invite and the code resolves, mirroring Task C2's E2E. Then:

```bash
git add -A server/src client/src e2e
git commit -m "Circle-level invites, mirroring the pod invite path"
```

---

### Task C4: Ship Wave C

- [ ] **Step 1: Confirm both migrations are present and idempotent**

```bash
ls server/src/db/migrations/ | tail -4
```

Expected: `088_job_title_provenance.sql`, `089_user_search_index.sql`. `CREATE EXTENSION IF NOT EXISTS pg_trgm` requires the Neon role to have permission — if the boot migration fails on it, fall back to plain B-tree indexes on `lower(display_name)` and note it.

- [ ] **Step 2: Same ship sequence as Task A6**, plus `e2e/tests/search.spec.ts` and `e2e/tests/member-invites.spec.ts` in the smoke run.

---

# WAVE D — Presentation and copy

---

### Task D1: Profile card rebuild

Stefan: "Profile card needs a major visual upgrade (greatest thing on the platform)" and "About section was cut off/too narrow."

**Files:**
- Modify: `client/src/features/profile/PublicProfilePage.tsx`
- Test: `e2e/tests/wave12-edge-cases.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test('the profile card shows the whole About section at every width', async () => {
  test.setTimeout(240_000);
  const subject = await createTestUser('edgeProfile');
  const LONG = 'I build things. '.repeat(40).trim();
  await setProfile(subject, { bio: LONG, job_title: 'Senior React Developer', company: 'TestCo' });

  for (const width of [360, 390, 768, 1280]) {
    const page = await openAs(owner, `/profile/${subject.id}`, { width, height: 900 });
    const about = page.getByTestId('profile-about');
    await expect(about).toBeVisible({ timeout: 30_000 });

    // Not clipped: the rendered height must fit the full text, not a fixed box.
    const clipped = await about.evaluate(el => el.scrollHeight > el.clientHeight + 2);
    expect(clipped, `About clipped at ${width}px`).toBe(false);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `sideways scroll at ${width}px`).toBeLessThanOrEqual(0);
    await page.context().close();
  }
  await cleanup(pool, { ids: [subject.id] });
});
```

- [ ] **Step 2: Run it, then rebuild the card**

Give the About block `data-testid="profile-about"`, remove any fixed height or `line-clamp` on it, and let it wrap. Widen the card container on desktop. Keep the existing meta row, LinkedIn line and message-gate block working — they are covered by the S22 test in `server/src/__tests__/services/orchestration/s22-dm-lock-visible-reason.test.ts`, which reads this file's source and will fail loudly if the branches are removed.

- [ ] **Step 3: Run the S22 test too, then commit**

```bash
cd server && npx jest --coverage=false src/__tests__/services/orchestration/s22-dm-lock-visible-reason.test.ts
cd ../e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/wave12-edge-cases.spec.ts -g "whole About" --workers=1 --retries=0
git add -A client/src e2e && git commit -m "Profile card shows the whole About section at every width"
```

---

### Task D2: A warmer host prompt

**Files:**
- Modify: `server/src/services/onboarding/prompts.ts`
- Test: `server/src/__tests__/services/onboarding/prompts.test.ts` (existing — read it first)

- [ ] **Step 1: Read the existing prompt test**

```bash
cd server && npx jest --coverage=false src/__tests__/services/onboarding/prompts.test.ts --verbose 2>&1 | head -30
```

That suite already pins behaviours the prompt must keep — on a previous rewrite it caught the loss of "who they would be valuable to". Do not weaken it; add to it.

- [ ] **Step 2: Add the tone assertions**

```typescript
// 13 Aug: "currently too transactional/cold; needs to feel more human."
describe('the host sounds like a person', () => {
  it('does not interrogate — no stacked questions in one turn', () => {
    expect(HOST_PROMPT).toMatch(/one question at a time/i);
  });

  it('reacts to what the member said before asking the next thing', () => {
    expect(HOST_PROMPT).toMatch(/acknowledge/i);
  });

  it('still collects who they want to meet and who they would be valuable to', () => {
    expect(HOST_PROMPT).toMatch(/who they want to meet/i);
    expect(HOST_PROMPT).toMatch(/valuable to/i);
  });
});
```

- [ ] **Step 3: Rewrite the prompt, run the whole prompts suite**

Keep every existing requirement. Add the tone rules. Run:

```bash
cd server && npx jest --coverage=false src/__tests__/services/onboarding/
```

Expected: everything green, including the pre-existing assertions.

- [ ] **Step 4: Smoke it against the real model**

The onboarding E2E drives the real Anthropic API. Run it and read the transcripts it prints:

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/onboarding-states.spec.ts --workers=1 --retries=0
```

A green run proves the states still work. Whether it *sounds* human is a judgement call — paste two real transcripts into the report for Ali and Stefan to read.

- [ ] **Step 5: Commit**

```bash
git add -A server/src && git commit -m "The onboarding host reacts before it asks"
```

---

### Task D3: The invite email says what RSN is

Claus's preference: explain it in the invite email rather than building an on-platform explainer.

**Files:**
- Modify: `server/src/services/email/email.service.ts` (the invite template)
- Test: `server/src/__tests__/services/email/` (follow the existing template-test pattern)

- [ ] **Step 1: Find the invite template**

```bash
grep -n "invite" server/src/services/email/email.service.ts | head -20
```

- [ ] **Step 2: Write the failing test**

```typescript
// 13 Aug: "New user has no idea what RSN is when landing after clicking an
// invite link" — Claus preferred fixing this in the email rather than the UI.
it('the invite email explains what Reason is before asking anyone to join', () => {
  const html = buildInviteEmail({ inviterName: 'Stefan', code: 'ABC123' });
  expect(html).toMatch(/networking/i);
  expect(html).toMatch(/Stefan/);
  // It says what happens next, not just "click here".
  expect(html).toMatch(/what happens next|you'll be asked|takes about/i);
});
```

Use the real function name and signature from step 1.

- [ ] **Step 3: Write the copy**

Two short paragraphs above the button, in plain prose, no marketing voice:

```
Stefan invited you to Reason.

Reason is a private network where people meet for a stated reason rather than
by browsing profiles. You say who you are looking for, and it keeps looking —
including as new people join.

Joining takes a few minutes: a short conversation about who you want to meet,
and you are in.
```

- [ ] **Step 4: Run, verify the rendered email, commit**

```bash
cd server && npx jest --coverage=false src/__tests__/services/email/
git add -A server/src && git commit -m "The invite email says what Reason is"
```

---

### Task D4: Ship Wave D and report

- [ ] **Step 1: Same ship sequence as Task A6**, with every spec file in the smoke run:

```bash
cd e2e && JWT_SECRET=$(cat .jwt_secret) npx playwright test tests/matching-agents.spec.ts tests/wave12-edge-cases.spec.ts tests/match-accept-ui.spec.ts tests/circle-links.spec.ts tests/onboarding-states.spec.ts tests/search.spec.ts tests/member-invites.spec.ts --reporter=list --workers=1 --retries=0
```

- [ ] **Step 2: Post-deploy production data check**

```sql
SELECT COUNT(*) FROM users WHERE email LIKE 'e2etest-%';            -- must be 0
SELECT COUNT(*) FROM matching_agents WHERE last_matched_at IS NULL
   AND status = 'active';                                            -- must be 0
SELECT COUNT(*) FROM users WHERE job_title_source = 'inferred';      -- expect > 0 over time
```

- [ ] **Step 3: Write the report for Ali**

Numbered, plain-English steps he can follow himself, covering: the new dashboard order, the badge, search, a member invite, a circle invite, the first agent after onboarding, the message header, the profile About section, and a bare `www.` link in a circle post. State explicitly what was NOT done: no recommendation umbrella (rename only), no invite quota (his decision), no search opt-out, and `job_title_source` left NULL for pre-088 members.

---

## Sequencing and risk

**Order:** A → B → C → D. Wave A is client-only and reversible. Wave B changes matching inputs, so it ships alone and gets its own smoke run. Wave C adds the largest surface. Wave D is presentation.

**The riskiest change is B1.** It alters what the matcher reads. Ship it separately from everything else, and re-run a full network rescore afterwards so stored reasons reflect the new ordering — the 6 August lesson was that code changes do not update stored text.

**The one with no technical risk and the most social risk is C2.** Unlimited member invites is Ali's explicit decision against the recommendation. Audit logging is retained. If dilution shows up, the lever is a quota, and it is a one-line change to add later.

**Watch the Anthropic balance** before Wave D2's smoke run — the prod key is prepaid, and every LLM feature fails at once when it empties.
