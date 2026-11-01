// ─── What the Remind all button tells the host ─────────────────────────────────────────────────────

export interface RemindAllAnswer {
  reminded: number;
  total: number;
  recentlyReminded?: number;
}

export interface RemindAllToast {
  message: string;
  type: 'success' | 'info' | 'error';
}

const NO_REMINDERS = 'No reminders were sent.';
const TRY_AGAIN = 'Please try again in a moment.';

/**
 * Nothing sent is never the success colour: it says so, and why when the server's numbers say why. A press
 * reminds at most 50 invites, so a press that leaves more waiting says to press again.
 */
export function remindAllToast({ reminded, total, recentlyReminded = 0 }: RemindAllAnswer): RemindAllToast {
  if (reminded <= 0) {
    if (total <= 0 && recentlyReminded > 0) return { message: `${NO_REMINDERS} Everyone was reminded less than an hour ago.`, type: 'info' };
    if (total <= 0) return { message: `${NO_REMINDERS} Nobody is waiting for a reminder.`, type: 'info' };
    return { message: `${NO_REMINDERS} ${TRY_AGAIN}`, type: 'error' };
  }
  if (reminded < total) {
    return { message: `Reminders sent to ${reminded} of ${total}. Press Remind all again for the rest.`, type: 'info' };
  }
  return { message: `Reminders sent to ${reminded} pending ${reminded === 1 ? 'invite' : 'invites'}.`, type: 'success' };
}

/** A refused press: the server's own sentence when it gave one. */
export function remindAllFailure(serverMessage: string | undefined): string {
  return `${NO_REMINDERS} ${serverMessage || TRY_AGAIN}`;
}
