// ─── The invite sheet's shared looks (P29: split out of InvitePickerSheet.tsx, 1 Nov 2026) ───────────────────────
import type { InviteCandidateState } from '@rsn/shared';
import { cn } from '@/lib/utils';

export const BUTTON = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[11px] px-4 text-[14px] font-bold';
export const QUIET = cn(BUTTON, 'border border-reason-line bg-white text-[#2d3440] hover:bg-reason-soft');
export const BADGE: Record<InviteCandidateState, string> = {
  available: '',
  member: 'bg-[#e8f6ef] text-[#11744a]',
  going: 'bg-[#e8f6ef] text-[#11744a]',
  invited: 'bg-[#fff4e5] text-[#8a4f06]',
  declined: 'bg-reason-soft text-[#4f5562]',
};

/** Someone chosen in the sheet, shown as a chip until the batch answers for them. */
export interface Chosen { userId: string; displayName: string }
