import { cn } from '@/lib/utils';

export type ReasonSheepPose = 'match' | 'curious' | 'hopeful' | 'thinking';

export default function ReasonSheep({ pose, className }: { pose: ReasonSheepPose; className?: string }) {
  return <img src={`/sheep/v4/${pose}.png`} alt="" aria-hidden="true" loading="lazy" className={cn('object-contain', className)} />;
}
