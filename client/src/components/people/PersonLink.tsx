import type { ReactNode } from 'react';
import ProfileLink from '@/components/ui/ProfileLink';
import type { KnownSource } from '@/features/reason/human/profile-text';

// A person's name and picture, as one way to their profile (30 Oct 2026 review, item 4.3, L7): "Names should be
// clickable. In messages, you can't click the other person's name to go to their profile." Built on ProfileLink, the one
// way to link a member (its `from` says where the profile was opened from, and inside a live event it opens a new tab,
// which ws2-profile-link-safety.test.ts holds). Someone whose account is closed is a former member: shown, never linked,
// as they cannot be reached.

// The one client constant for a closed account's name, re-exported here for the screens that link people.
export { FORMER_MEMBER, isFormerMemberName } from '@/lib/former-member';

export default function PersonLink({ userId, from, former = false, newTab = false, className, title, children }: {
  userId: string;
  from: KnownSource;
  /** A closed account: drawn the same, as plain text. */
  former?: boolean;
  /** Inside a live event only (ProfileLink's rule). */
  newTab?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  if (former) return <span className={className} data-testid="person-former">{children}</span>;
  return (
    <ProfileLink userId={userId} from={from} newTab={newTab} className={className} title={title}>
      {children}
    </ProfileLink>
  );
}
