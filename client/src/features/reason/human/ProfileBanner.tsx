// client/src/features/reason/human/ProfileBanner.tsx
// The banner across the top of a profile (21 Oct 2026): the member's picture, or the default gradient, which is
// the old public profile's. The same box on every profile and on your own, so the strip you choose is the strip
// everyone sees: the whole 3:1 picture on a phone and a tablet, its middle band on a wide screen.
import { useState, type ReactNode } from 'react';

const BOX = 'relative aspect-[3/1] max-h-[260px] w-full overflow-hidden rounded-[21px] bg-gradient-to-r from-[#1a1a2e] via-[#3a1f3d] to-reason-red md:rounded-[26px]';

interface Props {
  src: string | null;
  /** Controls drawn over the banner (Change banner and Remove, on your own profile). */
  children?: ReactNode;
}

export default function ProfileBanner({ src, children }: Props) {
  // A picture that fails to load draws the gradient, the way a failed photo draws initials. What is remembered is
  // which picture failed, so a new banner (a new address) is tried again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <div className={BOX} data-testid="profile-banner">
      {src && src !== failedSrc && (
        <img src={src} alt="" onError={() => setFailedSrc(src)} className="absolute inset-0 h-full w-full object-cover" />
      )}
      {children}
    </div>
  );
}
