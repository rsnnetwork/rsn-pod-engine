// client/src/components/ui/FormSummary.tsx
// The line beside a form's submit button: "Fix 2 things: Title, Capacity", each name a button that takes the member
// to that field (which says its own problem beside it), and the one sentence a refusal that names no field says.
// 25 Oct walkthrough: the event title's "Required" sat three screens above the button on a phone, so the member
// pressed it and saw nothing happen.
import { cn } from '@/lib/utils';

export interface FormSummaryItems {
  /** "Fix 1 thing:" */
  lead: string;
  items: { key: string; label: string }[];
}

interface Props {
  summary: FormSummaryItems | null;
  /** What a refusal said that belongs to no field. */
  message?: string | null;
  onGoTo: (key: string) => void;
  className?: string;
}

export default function FormSummary({ summary, message, onGoTo, className }: Props) {
  if (!summary && !message) return null;
  return (
    <div role="alert" className={cn('min-w-0 text-[13px] leading-snug text-red-600', className)}>
      {summary && (
        <p className="flex flex-wrap items-center gap-x-1">
          <span className="font-semibold">{summary.lead}</span>
          {summary.items.map((item, i) => (
            <span key={item.key} className="inline-flex items-center">
              <button
                type="button"
                onClick={() => onGoTo(item.key)}
                className="inline-flex min-h-[44px] items-center rounded-md px-1 underline underline-offset-2 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
              >
                {item.label}
              </button>
              {/* Against the label: the button's own padding would put a space before the comma. */}
              {i < summary.items.length - 1 && <span aria-hidden="true" className="-ml-1">,</span>}
            </span>
          ))}
        </p>
      )}
      {message && <p className="[overflow-wrap:anywhere]">{message}</p>}
    </div>
  );
}
