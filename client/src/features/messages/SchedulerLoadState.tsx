// The scheduler before its times have arrived: a spinner, or, when they could not be loaded, the reason and a way to
// try again (never a blank panel).

import { Spinner } from '@/components/ui/Spinner';

export default function SchedulerLoadState({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  if (!failed) return <div className="p-4 flex justify-center"><Spinner /></div>;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-sm text-gray-600" data-testid="meeting-scheduler">
      <span>We could not load the times.</span>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        Try again
      </button>
    </div>
  );
}
