import Avatar from './Avatar';
import Badge from './Badge';
import { Briefcase, MapPin } from 'lucide-react';

// Public card only (Stefan, 9 Sep 2026): who someone is and what they offer.
// Why they're here (who they want to meet, intent, interests) is private to
// them and admins and is never handed to this component.
export interface ProfileCardData {
  id: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string | null;
  bio?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  industry?: string | null;
  location?: string | null;
  expertiseText?: string | null;
}

interface ProfileCardProps {
  user: ProfileCardData;
  compact?: boolean;
  className?: string;
  onClick?: () => void;
  badge?: string;
  badgeVariant?: 'default' | 'success' | 'warning' | 'info' | 'brand';
}

export default function ProfileCard({ user, compact = false, className = '', onClick, badge, badgeVariant = 'default' }: ProfileCardProps) {
  if (compact) {
    return (
      <div
        onClick={onClick}
        className={`flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors ${onClick ? 'cursor-pointer' : ''} ${className}`}
      >
        <Avatar src={user.avatarUrl} name={user.displayName} size="md" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-800 truncate">{user.displayName}</p>
            {badge && <Badge variant={badgeVariant} className="text-[10px]">{badge}</Badge>}
          </div>
          {(user.jobTitle || user.company) && (
            <p className="text-xs text-gray-400 truncate">
              {user.jobTitle}{user.jobTitle && user.company ? ' at ' : ''}{user.company}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      className={`rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      <div className="flex items-start gap-3 mb-3">
        <Avatar src={user.avatarUrl} name={user.displayName} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-gray-800 truncate">{user.displayName}</p>
            {badge && <Badge variant={badgeVariant}>{badge}</Badge>}
          </div>
          {(user.jobTitle || user.company) && (
            <p className="text-sm text-gray-500 flex items-center gap-1 mt-0.5">
              <Briefcase className="h-3 w-3 shrink-0" />
              {user.jobTitle}{user.jobTitle && user.company ? ' at ' : ''}{user.company}
            </p>
          )}
          {user.location && (
            <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
              <MapPin className="h-3 w-3 shrink-0" /> {user.location}
            </p>
          )}
        </div>
      </div>

      {user.bio && (
        <p className="text-sm text-gray-600 line-clamp-4 mb-2 leading-relaxed">{user.bio}</p>
      )}

      {user.expertiseText && (
        <p className="border-t border-gray-100 pt-2 mt-2 text-xs text-gray-600 line-clamp-2">{user.expertiseText}</p>
      )}
    </div>
  );
}
