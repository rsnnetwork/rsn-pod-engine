// "Another time": any time of day, typed (Ali, 9 Sep). It joins the member's picks on blur, on Enter and on Add time; a
// time typed and left used to vanish without a word.

import { SLOT_MINUTES, dayLabel } from './scheduler-flow';

interface Props {
  dayKey: string;
  value: string;
  onChange: (value: string) => void;
  /** Add the typed time to the picks. */
  onAdd: () => void;
  /** Add time pressed with nothing typed. */
  onEmpty: () => void;
}

export default function SchedulerTypedTime({ dayKey, value, onChange, onAdd, onEmpty }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="custom-time">
      <label htmlFor="custom-time" className="text-[11px] font-medium text-gray-700">Another time on {dayLabel(dayKey)}</label>
      <input
        id="custom-time"
        type="time"
        step={SLOT_MINUTES * 60}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onAdd}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
        aria-label="Another time, 24-hour"
        className="h-11 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-800"
      />
      <button
        type="button"
        // Keep the focus in the box: this press adds the time. Letting the box
        // blur first added it there and left the press an empty box to complain about.
        onMouseDown={e => e.preventDefault()}
        onClick={() => (value ? onAdd() : onEmpty())}
        className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        Add time
      </button>
      <span className="text-[11px] text-gray-500">Type any time. It joins your times above.</span>
    </div>
  );
}
