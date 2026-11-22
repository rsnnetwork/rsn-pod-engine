// ─── One compact row of a pod's member list (21 Nov 2026) ─────────────────────────────────────────────────────────
// The photo, the name with the member's badge and their Director or Host chip, and "title · company" on one line,
// each truncated so the row never widens the page at 360. The row opens the member's Human Profile; the director's
// actions are in the "⋯" button beside it (a separate control, never inside the link).
import { Link } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import Badge from '@/components/ui/Badge';
import ProfileBadge from '@/components/ui/ProfileBadge';
import { personHref } from '@/features/reason/human/profile-text';
import PodMemberMenu, { type PodMemberMenuItem } from './PodMemberMenu';
import { memberName, memberRoleChip, memberSubtitle, type PodMemberRow as Member } from './pod-members-view';

export default function PodMemberRow({ m, menu }: { m: Member; menu: PodMemberMenuItem[] }) {
  const name = memberName(m);
  const subtitle = memberSubtitle(m);
  const chip = memberRoleChip(m.role);
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-xl border border-gray-200 bg-white pr-1" data-testid={`pod-member-row-${m.userId}`}>
      <Link to={personHref(m.userId || m.id, 'Pods')} className="flex min-h-[56px] min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-gray-50">
        <Avatar src={m.avatarUrl} name={name} size="md" className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-[#1a1a2e]">{name}</span>
            <ProfileBadge badge={m.profileBadge} />
            {chip && <Badge variant={chip === 'Director' ? 'brand' : 'info'} className="shrink-0 px-2 text-[11px]">{chip}</Badge>}
          </div>
          {subtitle && <p className="truncate text-xs text-gray-500">{subtitle}</p>}
        </div>
      </Link>
      <PodMemberMenu name={name} items={menu} testId={`pod-member-menu-${m.userId}`} />
    </div>
  );
}
