// ─── Subscription & Entitlement Types ────────────────────────────────────────

export enum SubscriptionPlan {
  FREE = 'free',
  MEMBER = 'member',
  PREMIUM = 'premium',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  TRIALING = 'trialing',
  NONE = 'none',
}

export interface UserSubscription {
  id: string;
  userId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserEntitlement {
  id: string;
  userId: string;
  maxPodsOwned: number;
  maxSessionsPerMonth: number;
  maxInvitesPerDay: number;
  canHostSessions: boolean;
  canCreatePods: boolean;
  accessLevel: string;
  overrides: Record<string, boolean>;
  createdAt: Date;
  updatedAt: Date;
}
