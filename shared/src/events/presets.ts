// ─── Speed-networking presets: who should meet whom (30 Oct 2026, L19) ───────────────────────────
//
// Four matching_templates rows (migration 126, is_preset = true) that any organiser may choose for a speed-networking
// event. Each is a set of soft weights over the signals the engine already scores (who people want to meet, from
// onboarding; complementary roles; the check-in intention): the engine prefers these pairings, it does not
// guarantee them, which is why the cards say "first". Any other template stays a platform admin's pick.
//
// The ids are fixed so the forms can start on one (General; Founders and investors for a Two-Sided Networking pod)
// and migration-126.test.ts holds the migration to the same four.

export const MATCHING_PRESET_IDS = {
  general: '5e7b1a5e-0000-4000-8000-000000000001',
  foundersInvestors: '5e7b1a5e-0000-4000-8000-000000000002',
  jobsHiring: '5e7b1a5e-0000-4000-8000-000000000003',
  mentorship: '5e7b1a5e-0000-4000-8000-000000000004',
} as const;

/** A preset as GET /sessions/matching-presets returns it: the card's name and its one line. */
export interface MatchingPreset {
  id: string;
  name: string;
  description: string | null;
}
