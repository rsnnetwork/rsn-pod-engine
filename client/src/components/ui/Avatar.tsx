import { useEffect, useState } from 'react';
import { cn, getInitials } from '@/lib/utils';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  className?: string;
}

const sizes = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-12 w-12 text-base', xl: 'h-16 w-16 text-lg', '2xl': 'h-24 w-24 text-2xl' };

export default function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  // 4 Sep 2026 (device audit): a member whose photo URL no longer resolves
  // showed the browser's broken-image glyph with the alt text beside it.
  // A failed load falls back to the initials, like a missing photo does.
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name}
        onError={() => setBroken(true)}
        className={cn('rounded-full object-cover', sizes[size], className)}
      />
    );
  }
  return (
    <div className={cn('rounded-full bg-brand-600 flex items-center justify-center font-semibold text-white', sizes[size], className)}>
      {getInitials(name)}
    </div>
  );
}
