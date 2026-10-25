// Post-Event Broadcast Messaging — shared DTOs.

export type PostEventMessageBucket =
  | 'stayed' | 'left_early' | 'could_not_join' | 'no_show';

export type PostEventMessageJobStatus =
  | 'pending' | 'processing' | 'completed' | 'completed_with_errors' | 'failed';

/** Why the current user can (or cannot yet) use the feature on an event. */
export interface BroadcastEligibility {
  /** True when the button should perform a real send (admins in v1). */
  enabled: boolean;
  /** True when the button should be shown at all (admins + hosts/directors). */
  visible: boolean;
  /** Machine reason for the disabled/coming-soon state. */
  reason: 'admin' | 'pro_coming_soon' | 'director_coming_soon' | 'not_allowed';
}

// ─── Version 2 (26 Oct 2026): the organiser writes the message ───────────────
//
// Asked for with `?v=2` on the eligibility call and a `body` on the send. A call that asks for neither
// gets the version 1 answers above, unchanged.

/** Why the "message everyone" panel can, or cannot yet, be used. */
export type BroadcastEligibilityReasonV2 =
  | 'ok' | 'not_ended' | 'not_organiser' | 'no_recipients' | 'limit' | 'sending';

/** Who would get the message, counted the way the send counts them (nobody blocked, no closed account). */
export interface BroadcastAudience {
  /** Everyone who joined the event, plus the host when someone else is sending; never the sender. */
  tookPart: number;
  /** People who registered and never joined; reached only when the sender asks for them. */
  registeredNoShow: number;
}

export interface BroadcastEligibilityV2 {
  /** True when a send would be accepted right now. */
  enabled: boolean;
  /** False when the person has no business seeing the panel at all (not an organiser). */
  visible: boolean;
  reason: BroadcastEligibilityReasonV2;
  /** The sentence to show as text. Empty when there is nothing to say (an organiser who can send). */
  explanation: string;
  audience: BroadcastAudience;
  /** The latest send that reached anyone: when it finished and how many people it reached. */
  lastSent?: { at: string; recipients: number };
  /** Only with reason 'limit': the instant (ISO) this person may send again. */
  nextSendAt?: string;
}

/** The body of a version 2 send. */
export interface PostEventMessageSendRequest {
  /** The organiser's own words, 1 to POST_EVENT_MESSAGE_LIMITS.bodyMax characters. Sent as written. */
  body: string;
  /** Also message the people who registered but never came. Off unless asked. */
  includeNoShows?: boolean;
}

/** The limits a version 2 send holds to. The server enforces them; a screen reads them to count. */
export const POST_EVENT_MESSAGE_LIMITS = {
  bodyMax: 2000,
  /** Sends per event, per sender, in any 24 hours. */
  sendsPerDay: 3,
} as const;

export interface PostEventMessageBucketCount {
  bucket: PostEventMessageBucket;
  count: number;
}

/** Returned by the dry-run preview: who would get messaged, grouped. */
export interface PostEventMessagePreview {
  sessionId: string;
  totalRecipients: number;
  buckets: PostEventMessageBucketCount[];
}

/** Returned by status endpoint and by create. */
export interface PostEventMessageJob {
  id: string;
  sessionId: string;
  status: PostEventMessageJobStatus;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
}
