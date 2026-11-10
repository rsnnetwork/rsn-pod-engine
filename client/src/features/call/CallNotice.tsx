// A final answer on the call page (Part 2, Task 12): the event has ended, was cancelled, the organiser declined, the event
// refused this person in its own words, or the link leads nowhere. One sentence, maybe a second, and a way on: never a
// dead end, never a code.
import type { ReactNode } from 'react';
import { AlertCircle, CalendarX2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  tone: 'closed' | 'refused' | 'info';
  title: string;
  detail?: string | null;
  testId: string;
  children?: ReactNode;
}

export default function CallNotice({ tone, title, detail, testId, children }: Props) {
  const Icon = tone === 'closed' ? CalendarX2 : tone === 'refused' ? AlertCircle : Info;
  return (
    <div className="space-y-4" data-testid={testId}>
      <div
        className={cn(
          'inline-flex h-12 w-12 items-center justify-center rounded-full',
          tone === 'refused' ? 'bg-reason-pink text-reason-red' : 'bg-reason-soft text-reason-muted',
        )}
      >
        <Icon aria-hidden="true" className="h-6 w-6" />
      </div>
      <h2 role={tone === 'refused' ? 'alert' : undefined} className="break-words text-[22px] font-extrabold leading-tight tracking-[-0.01em]">
        {title}
      </h2>
      {detail && <p className="break-words text-[15px] text-reason-muted">{detail}</p>}
      {children && <div className="flex flex-col gap-2 pt-1">{children}</div>}
    </div>
  );
}
