import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-6 w-6 animate-spin text-rsn-red', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex h-full items-center justify-center py-20">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-gray-100', className)} />;
}
