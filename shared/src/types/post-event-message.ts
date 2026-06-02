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
