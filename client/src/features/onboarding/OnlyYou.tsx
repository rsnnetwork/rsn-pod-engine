// Marks what nobody but the member sees (screen 7): who they would like to
// meet, what they are hoping to find, and their time zone.

import { Lock } from 'lucide-react';
import { PROFILE } from './flow';

export default function OnlyYou({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 ${className}`}>
      <Lock className="h-3 w-3" aria-hidden />
      {PROFILE.onlyYou}
    </span>
  );
}
