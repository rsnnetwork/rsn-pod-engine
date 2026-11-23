// The badge an admin gives a member (21 Nov 2026, Shradha: "can we update a premium badge to them").
// It only marks the person; it changes nothing about how they are matched. Shown beside a member's name
// wherever members are listed. Renders nothing for a member without one.
// The look is the ink pill with a red tick (23 Nov 2026, Shradha's option 1c, chosen by Ali): dark so it stands apart
// from the red Message button beside it, and it keeps the word, since more badge kinds will come.
import { BadgeCheck } from 'lucide-react';
import type { ProfileBadgeKind } from '@rsn/shared';

const LABELS: Record<ProfileBadgeKind, string> = { premium: 'Premium' };

/** The badge's word, or null for none and for a value this build does not know (never a prototype key). */
export function profileBadgeLabel(badge: string | null | undefined): string | null {
  return badge && Object.prototype.hasOwnProperty.call(LABELS, badge) ? LABELS[badge as ProfileBadgeKind] : null;
}

// A list row's badge sits in the name's line; a profile's, under its large name, is a size up.
const SIZE = {
  sm: 'gap-1 py-0.5 pl-1 pr-2 text-[10px] leading-4',
  md: 'gap-1.5 py-1 pl-1.5 pr-2.5 text-[12px] leading-4',
} as const;

interface Props { badge?: string | null; size?: keyof typeof SIZE; className?: string }

export default function ProfileBadge({ badge, size = 'sm', className = '' }: Props) {
  const label = profileBadgeLabel(badge);
  if (!label) return null;
  return (
    <span
      data-testid="profile-badge"
      title={`${label} member`}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-gray-900 align-middle font-semibold tracking-normal text-white ${SIZE[size]} ${className}`}
    >
      <BadgeCheck className={`fill-red-500 text-white ${size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'}`} aria-hidden="true" />
      {label}
    </span>
  );
}
