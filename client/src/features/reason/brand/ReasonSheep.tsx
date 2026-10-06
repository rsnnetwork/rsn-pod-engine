import { useState } from 'react';
import { cn } from '@/lib/utils';

export type ReasonSheepPose = 'match' | 'curious' | 'hopeful' | 'thinking';

// The sheep is drawn in empty states and failure screens, which is where the picture is most likely to be missing
// too (offline, or a file that did not load). A picture that fails leaves the browser's broken-image box, so on error
// this draws nothing. It is keyed by pose below: a different pose is a new picture, with a try of its own.
function Picture({ pose, className }: { pose: ReasonSheepPose; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={`/sheep/v4/${pose}.png`} alt="" aria-hidden="true" loading="lazy" onError={() => setFailed(true)} className={cn('object-contain', className)} />;
}

export default function ReasonSheep({ pose, className }: { pose: ReasonSheepPose; className?: string }) {
  return <Picture key={pose} pose={pose} className={className} />;
}
