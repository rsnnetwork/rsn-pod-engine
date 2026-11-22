// The badge an admin gives a member (21 Nov 2026, Shradha: "can we update a premium badge to them").
// It only marks the person; it changes nothing about how they are matched. Shown beside a member's name
// wherever members are listed. Renders nothing for a member without one.
import { Sparkles } from 'lucide-react';
import type { ProfileBadgeKind } from '@rsn/shared';

const LABELS: Record<ProfileBadgeKind, string> = { premium: 'Premium' };

/** The badge's word, or null for none and for a value this build does not know (never a prototype key). */
export function profileBadgeLabel(badge: string | null | undefined): string | null {
  return badge && Object.prototype.hasOwnProperty.call(LABELS, badge) ? LABELS[badge as ProfileBadgeKind] : null;
}

// A list row's badge sits in the name's line; a profile's, under its large name, is a size up.
const SIZE = {
  sm: 'gap-1 px-2 py-0.5 text-[10px] leading-4',
  md: 'gap-1.5 px-2.5 py-1 text-[12px] leading-4',
} as const;

interface Props { badge?: string | null; size?: keyof typeof SIZE; className?: string }

export default function ProfileBadge({ badge, size = 'sm', className = '' }: Props) {
  const label = profileBadgeLabel(badge);
  if (!label) return null;
  return (
    <span
      data-testid="profile-badge"
      title={`${label} member`}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 align-middle font-semibold tracking-normal text-amber-800 ${SIZE[size]} ${className}`}
    >
      <Sparkles className={size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'} aria-hidden="true" />
      {label}
    </span>
  );
}
