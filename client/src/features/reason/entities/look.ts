// client/src/features/reason/entities/look.ts
// The Entities pages' buttons and panels, in the preview's own classes (MeetSheet, the Human Profile). Every button is
// at least 44px tall, and a red one only reacts to a hover while it can be pressed.
export const PRIMARY_BUTTON = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white shadow-[0_7px_18px_rgba(222,50,46,.18)] enabled:hover:bg-reason-red-hover disabled:opacity-60';
export const QUIET_BUTTON = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] border border-reason-line bg-white px-4 text-[14px] font-bold text-reason-ink disabled:opacity-60';

/** A white card on the page, as For You draws its list. */
export const PANEL = 'min-w-0 rounded-[15px] border border-reason-line bg-white p-[13px] shadow-[0_6px_24px_rgba(16,18,24,.025)] min-[721px]:rounded-[18px] min-[721px]:p-[18px]';
