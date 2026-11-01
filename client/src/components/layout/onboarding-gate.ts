// ─── The preview's onboarding gate (30 Oct review, 2.1 and 1.2; L3) ─────────
//
// "The users already on the platform who haven't done the new onboarding should be taken through it the next time
// they log in." Everyone, admins included (no role exemption: it is the same flow, about a minute long). A member who
// did the new onboarding without saying where they are based, or with only a country ("USA"), is asked for that once,
// on its own. Read from the session (GET /auth/session), which is re-read after every confirm, so the gate lets go at
// once and never loops.
//
// Fails open on what a session does not say: no status (a stale cached session) is never gated, and a session from a
// server that does not send onboardingVersion yet keeps the old rule (only an unfinished status is gated).

import { isLocationComplete } from '@rsn/shared';

export type OnboardingDue = 'flow' | 'location';

interface SessionMember {
  onboardingStatus?: string;
  onboardingVersion?: number | null;
  location?: string | null;
}

/** null to go where they were going; 'flow' for the whole new onboarding; 'location' for where they are based. */
export function onboardingDue(user: SessionMember | null | undefined): OnboardingDue | null {
  const status = user?.onboardingStatus;
  if (status === undefined) return null;
  if (status !== 'completed') return 'flow';
  if (user?.onboardingVersion === undefined) return null;
  if (user.onboardingVersion !== 2) return 'flow';
  return isLocationComplete(user.location) ? null : 'location';
}

/**
 * Pages the gate never diverts: onboarding itself (no loop), an invite being accepted, a live event, a 1:1 meeting
 * someone is waiting in, and a host's dashboard at the start of their event. Sign-out and the legal pages are never
 * gated either; none of them is a protected page today, and they are listed so none ever is.
 */
const EXEMPT = [
  /^\/onboarding$/,
  /^\/invite\//,
  /^\/session\/[^/]+\/live(?:\/|$)/,
  /^\/session\/[^/]+\/host(?:\/|$)/,
  /^\/meet\//,
  /^\/(?:logout|signout)$/,
  /^\/(?:privacy|terms)$/,
  /^\/legal(?:\/|$)/,
];

export function isGateExempt(pathname: string): boolean {
  return EXEMPT.some(rule => rule.test(pathname));
}

/** Where the gate sends them, carrying the page they were going to (never a page of onboarding itself). */
export function gateTarget(due: OnboardingDue, pathname: string, search: string): string {
  const page = pathname.startsWith('/onboarding') ? '/' : `${pathname}${search}`;
  const redirect = encodeURIComponent(page);
  return due === 'location' ? `/onboarding?edit=profile&redirect=${redirect}` : `/onboarding?redirect=${redirect}`;
}
