import { useState } from 'react';
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
  //
  // What is remembered is WHICH photo failed, not that "a photo" failed. The first
  // version reset a flag in an effect, and an effect runs after the first render, so
  // an error that arrived before it (a photo that fails at once) was undone and the
  // broken glyph stayed. Comparing with the current src needs no reset, and a new
  // src is a new photo, tried again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src && src !== failedSrc) {
    return (
      <img
        src={src}
        alt={name}
        onError={() => setFailedSrc(src)}
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
