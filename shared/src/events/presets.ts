// ─── Speed-networking presets: who should meet whom (30 Oct 2026, L19) ───────────────────────────
//
// Five matching_templates rows (migration 126, and Buyers and vendors from migration 147; is_preset = true) that any organiser may choose for a speed-networking
// event. Each is a set of soft weights over the signals the engine already scores (who people want to meet, from
// onboarding; complementary roles; the check-in intention): the engine prefers these pairings, it does not
// guarantee them, which is why the cards say "first". Any other template stays a platform admin's pick.
//
// The ids are fixed so the forms can start on one (General; Founders and investors for a Two-Sided Networking pod)
// and migration-126.test.ts / migration-147.test.ts hold the migrations to the same ids.

export const MATCHING_PRESET_IDS = {
  general: '5e7b1a5e-0000-4000-8000-000000000001',
  foundersInvestors: '5e7b1a5e-0000-4000-8000-000000000002',
  jobsHiring: '5e7b1a5e-0000-4000-8000-000000000003',
  mentorship: '5e7b1a5e-0000-4000-8000-000000000004',
  /** Part 3 Task 12 (migration 147): the Founders and investors weights, for buyers and vendors. */
  buyersVendors: '5e7b1a5e-0000-4000-8000-000000000005',
} as const;

/** A preset as GET /sessions/matching-presets returns it: the card's name and its one line. */
export interface MatchingPreset {
  id: string;
  name: string;
  description: string | null;
}
