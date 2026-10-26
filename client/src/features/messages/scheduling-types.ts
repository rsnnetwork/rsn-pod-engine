// The answer of GET/PUT /dm/conversations/:id/scheduling, as the scheduler, the thread banner and the call page read
// it. One query key, ['meetingScheduling', conversationId], with the dm-conversation entity tag.

export interface Scheduling {
  conversationId: string;
  partnerId: string;
  mine: string[];
  theirs: string[];
  overlap: string[];
  confirmed: {
    window: string; byUserId: string; at: string; startAt: string | null; durationMin: number | null;
    type: 'audio' | 'video' | null;
    /** The meeting's own record (26 Oct 2026), for a link to its page. Null for a legacy day part. */
    meetingId?: string | null;
  } | null;
  /** The partner changed availability since I last opened the scheduler. */
  schedulingUpdated?: boolean;
  /** Calls unlock once this pair's first scheduled meeting has happened. */
  callsUnlocked?: boolean;
}

export const schedulingKey = (conversationId: string) => ['meetingScheduling', conversationId] as const;
