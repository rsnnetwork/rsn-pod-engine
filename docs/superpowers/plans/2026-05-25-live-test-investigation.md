# 25 May live-test investigation — root causes + proposed solutions (NO fixes yet)

Investigation only, per Ali. Implement together later.

## The big realization
My 24-May "heartbeat-only" change (commit 267cc51) **over-corrected** and caused the
matching regression seen tonight. Issues A–D below are all facets of one thing: how a
**backgrounded / dropped mobile client recovers**.

---

### A. Participants in the main room not matched (and only a manual refresh fixes it)
- **Root cause:** 267cc51 made the tab-return resync **heartbeat-only**, removing the
  `session:join` re-announce. `session:join` is what RE-REGISTERS a dropped/backgrounded
  user (handleJoinSession resets stuck status → in_main_room and re-joins rooms). Without
  it, a user whose socket/heartbeat went stale stays flagged `disconnected` → the matcher
  skips them. A manual browser refresh runs a full `session:join` → re-registers → matched.
- **Proposed solution:** restore a re-register on foreground return (`session:join`, not
  just heartbeat), so recovery is automatic. But fix the two reasons I removed it (B, C).

### B. Someone shown in the breakout room AND the main room (state mix)
- **Root cause:** the handleJoinSession reset flips stuck status (`disconnected`/`in_round`)
  → `in_main_room`, guarded by "no ACTIVE match." In the round-transition window (round N
  just `completed`, round N+1 still `scheduled` not yet `active`), a `session:join` can flip
  a user who is about to be / just was in a breakout → shows in two places.
- **Proposed solution:** widen the guard to "no active AND no scheduled match," and ensure
  the main-room participant set excludes anyone with an active/scheduled breakout match.
  This makes restoring session:join (A) safe.

### C. Skip re-prompts the rating form (on refresh / reconnect)
- **Root cause:** a SKIP is never recorded server-side. The rating-replay re-sends the form
  to anyone with **no submitted rating** (`SELECT id FROM ratings WHERE match_id AND
  from_user_id`). A skipper has no row → re-prompted on any `session:join` (refresh/reconnect).
- **Proposed solution:** record the skip. Simplest options: (1) client emits a `rating:skip`
  the server records (in-memory per-session set, checked by the replay + endRound dedup), or
  (2) persist a skip marker on the ratings row. Then Submit OR Skip both close the round; the
  form returns only on a genuine full miss (disconnected through the whole window).

### D. Host tile "vanished" on mobile; only a manual refresh brings it back
- **Root cause:** the LiveKit VIDEO connection is separate from the control socket. When a
  mobile tab backgrounds, LiveKit drops and does not reliably auto-reconnect on foreground;
  recovering the control socket doesn't bring the video tile back. A full page refresh
  re-inits LiveKit.
- **Proposed solution:** on foreground return, if the LiveKit room is disconnected, re-init
  it (re-fetch token + reconnect the video room). If reliable LiveKit reconnect isn't
  feasible, a guarded auto-recovery (re-sync + re-join video; last-resort one-time guarded
  reload) so the user never has to refresh manually.

### E. Co-host promote/remove takes ~10s to show on the HOST's screen
- **Root cause:** CLIENT-SIDE, test-setup artifact. Server emits `cohost:assigned`/`removed`
  to the **whole session room instantly** + a direct `permissions:updated` to the affected
  user; the host's `ParticipantList` badge reads the LIVE `cohosts` Zustand set
  (`cohosts.has(uid)`), updated the instant the event arrives. The lag is the host's browser
  tab not PROCESSING the socket event for ~10s — consistent with 6–7 tabs each decoding a
  LiveKit video stream on one laptop, starving/throttling the host tab's event loop. The
  affected user's tab happened to process instantly.
- **Proposed solution:** none required for production (one device per user = no starvation).
  Optional hardening: faster safety-net resync of cohosts, but the real lever is the test
  environment. Confirm in a real multi-device event before spending effort.

### F. Breakout-room timer mixing with other/old room timers
- **Root cause:** client stores ONE global `timerSeconds`. The round/rating segment timer
  broadcasts `timer:sync` to the whole session room (carries `segmentType`); breakout timers
  emit per-user with NO scope. They overwrite each other, and stale timers from old
  rooms/events leak ticks (code comment already admits "ended manual room's 8:20" leaks).
- **Proposed solution:** tag breakout `timer:sync` with `segmentType:'breakout'` + roomId;
  client applies only the tick matching its CURRENT context (room/phase) and ignores others;
  clear stale timers hard on round/event end.

### G. Rating-form timer (30s pair / 60s trio) mixing
- **Root cause:** same single global `timerSeconds` — the rating window writes the field the
  round/breakout timer also writes.
- **Proposed solution:** scoped rating timer; client applies only its current-context tick.

### H. Host-screen "refresh glimpse" (tiles blank for a moment)
- **Root cause:** a state-snapshot refetch (30s periodic + the foreground resync) momentarily
  clears the participant list to empty while reloading → grid blanks then repopulates.
- **Proposed solution:** non-destructive refetch (keep previous list rendered during reload).

---

## Suggested implement order (when Ali is back)
1. A+B+C together (restore session:join recovery + guard + record skip) — the core matching/
   refresh/skip cluster, one coherent change.
2. F+G (timer scoping) — careful, well-tested.
3. H (non-destructive refetch).
4. D (LiveKit video reconnect) — separate, needs care.
5. E — verify in a real multi-device event before any change.
