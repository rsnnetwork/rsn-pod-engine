import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { DmGroupSummary } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { formatRelative } from './message-time';
import { NO_MESSAGES_YET, groupPreview, memberCountLabel } from './group-chat-text';

// ─── A group chat in the Messages inbox (26 Oct 2026, C12, COM-04) ───
// Beside the one-to-one conversations, drawn the same way: the group's name, how many people are in it, its last message
// with who wrote it, and the unread count. It opens the group at /messages/g/:groupId.

interface Props {
  group: DmGroupSummary;
  /** This group is the one open beside the inbox. */
  active: boolean;
  myUserId: string;
}

export default function GroupInboxRow({ group, active, myUserId }: Props) {
  const preview = groupPreview(group.lastMessage, myUserId);
  const unread = group.unreadCount > 0;
  return (
    <Link
      to={`/messages/g/${group.id}`}
      data-testid="group-row"
      aria-current={active ? 'page' : undefined}
      className={cn('flex items-center gap-3 border-b border-gray-100 px-4 py-3 transition-colors hover:bg-gray-50', active && 'bg-rsn-red/5')}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600" aria-hidden="true">
        <Users className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between">
          <p className="truncate text-sm font-medium text-[#1a1a2e]">{group.name}</p>
          {group.lastMessageAt && <span className="ml-2 flex-shrink-0 text-[11px] text-gray-400">{formatRelative(group.lastMessageAt)}</span>}
        </div>
        <p className="truncate text-xs text-gray-500">{memberCountLabel(group.memberCount)}</p>
        <p className={cn('truncate text-xs', unread ? 'font-semibold text-[#1a1a2e]' : 'text-gray-500')}>
          {preview ?? <em className="text-gray-400">{NO_MESSAGES_YET}</em>}
        </p>
      </div>
      {unread && (
        <span data-testid="group-unread" className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rsn-red px-1 text-[10px] font-bold text-white">
          {group.unreadCount > 99 ? '99+' : group.unreadCount}
        </span>
      )}
    </Link>
  );
}
