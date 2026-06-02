# RSN Matching Spec — Full Compliance Rebuild (Master Plan)

**Date:** 2026-05-05
**Source docs:** `RSN/assets/Matching algorithm 1.0.pdf` (14-section spec) + `RSN/assets/5th may edits for rsn.pdf` (Stefan's 14 stability items)
**Target:** Pass every bullet of Section 14 (Acceptance Criteria) of the spec.
**Estimated effort:** ~21–28 focused days, shipped across 9 phases.
**Failure mode of the previous plan:** patched symptoms; left "execute session by session" as the architecture, which violates spec §5 ("Plan globally, do not match session by session"). Most observed bugs (greedy bye, Re-match feels fake, round count drift) collapse into "we never planned globally."

---

## Phase order + ETA

| # | Phase | Days | Ships |
|---|---|---|---|
| 1 | Quick wins + greedy completeness fallback | 1 | Closes today's visible bugs from session `3fc21cbb`; per-user recap; Re-match no longer pointless; no bye when complete matching exists |
| 2 | State machine adoption | 3–5 | Stefan #1, #2, #13 closed; leave-and-rejoin no longer needed |
| 2.5 | **Pre-event session planning** (architectural spine) | 5–7 | Spec §5 met; entire event plan generated upfront; greedy replaced with globally optimal matching |
| 2.7 | Future-only repair | 3 | Spec §9 met; late-joiner / leaver / disconnect handled per spec rules |
| 2.8 | Fallback ladder + multi-trio | 2 | Spec §10 met; nobody is bye-d unless physically impossible |
| 3 | Host dashboard + UI sync | 2–3 | Stefan #6, #7, #9, #11, #12 closed; canonical state visible to host live |
| 4 | Atomic room ops + chat reliability | 2 | Stefan #8 (chat), room creation/move atomic with rollback |
| 5 | Error surfacing + test mode | 2 | Stefan #14 closed; multi-account test sessions clearly labelled |
| 5.5 | Real learning loop | 3 | Spec §8 lifted from stub to real; `pair_relationship` aggregate populated, used in planning |
| 6 | Hardening + acceptance gate | 3 | All 10 acceptance bullets pass automated tests; 100-user mock event clean; Stefan demo |

**Total: 26 days at the optimistic end, 30 at the pessimistic.**

---

## Per-phase spec coverage

| Phase | Spec sections closed | Stefan items closed |
|---|---|---|
| 1 | partial §10 (greedy completeness) | #3, #4, #10, #11 |
| 2 | partial §12 | #1, #2, #13 |
| 2.5 | §3 ("plan globally"), §5, §6 (priority order) | #5 |
| 2.7 | §9 | parts of #1, #4 |
| 2.8 | §10 (fallback + trio rotation) | #4 |
| 3 | partial §12 (state visibility) | #6, #7, #9, #11, #12 |
| 4 | — | #8 |
| 5 | — | #14 |
| 5.5 | §4 (pair_relationship), §8 | — |
| 6 | §14 (acceptance) | — |

---

## Iron rules carried into every phase (RajaSkill)

1. **Audit before code.** Read the actual files for the area being touched, not memory. Grep for callers, check tests, confirm patterns.
2. **TDD for logic.** Architectural-pin tests for wiring (grep-style like the existing phase tests).
3. **Plan + explicit approval.** No code starts without the user reading the phase plan and saying go.
4. **Production safety.** Every prod DB op (migration apply, surgical cleanup, schema change) confirmed before execution.
5. **Full-stack verify** before claiming done: DB applied → server tests → server build → client type-check → client build → browser walk → CI green on staging + main → Render live → Vercel ready → Sentry zero new.
6. **Push staging → green → main → green.** Both branches always.
7. **Progress.md updated** per phase with timestamp, files touched, decisions, verification evidence.
8. **No AI attribution** in any pushed text (commits, PRs, issues).
9. **Real secrets stay local.** `.env.example` empty; pre-commit hook is the last line of defense.
10. **If CI breaks → fix immediately.** Never leave a red build.

---

## Forward-architecture compatibility (every phase honours)

- Anything that touches in-process state must be Redis-portable (Phase 2 of the original architecture upgrade).
- No N+1 queries in any new path. Indexed up front.
- Every new endpoint behind `authenticate` middleware unless explicitly public.
- Every new socket event registered in `shared/src/types/events.ts` so client/server stay typed.
- Every new DB table cascades correctly on user/session delete (FK ON DELETE CASCADE).
- Migrations are additive + reversible. No DROP COLUMN without explicit user approval.

---

## What "perfect this time" means in practice

Every claim of "done" in the rebuild requires evidence:

- "Migration applied" → `SELECT to_regclass('public.X')` returns non-null
- "Endpoint works" → curl response with the exact expected shape
- "UI renders" → screenshot or browser walk note
- "Tests pass" → `n / n tests pass` in jest output
- "CI green" → `gh run view` returns `conclusion: success`
- "Sentry clean" → API call returns 0 unresolved post-deploy
- "Render deploy live" → API call returns `status: live` at the pushed SHA
- "Vercel deploy ready" → `vercel ls` shows `Ready`

If any one of these fails, work blocks until fixed. No "I think it works" passes.

---

## Phase 1 detail

(See companion: `2026-05-05-phase-1-quick-wins.md`)

Subsequent phases get their own plan docs as we approach them, each with the same level of detail.
