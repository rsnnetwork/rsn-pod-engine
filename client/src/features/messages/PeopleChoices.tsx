import type { UseFormRegisterReturn } from 'react-hook-form';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import type { EventPerson } from './group-chat-text';

// ─── Choosing people who took part in an event (26 Oct 2026, C12, COM-04) ───
// The start sheet and the members sheet's "Add people" list them the same way: a row of at least 44px per person, with
// a box to tick. Once the group would be full, every box not ticked is off; the caller says why.

interface Props {
  legend: string;
  /** The heading above already says what the list is: the legend is for screen readers only. */
  legendHidden?: boolean;
  people: EventPerson[];
  chosen: string[];
  /** How many more can be ticked. At 0, every box not ticked is off. */
  room: number;
  /** The form's field for the ticked ids (react-hook-form's register of an array field). */
  field: UseFormRegisterReturn;
}

export default function PeopleChoices({ legend, legendHidden = false, people, chosen, room, field }: Props) {
  return (
    <fieldset>
      <legend className={legendHidden ? 'sr-only' : 'text-sm font-medium text-gray-700'}>{legend}</legend>
      <ul className="mt-1 divide-y divide-gray-100">
        {people.map((p) => {
          const name = p.displayName?.trim() || 'Member';
          const off = room === 0 && !chosen.includes(p.userId);
          return (
            <li key={p.userId}>
              <label className={cn('flex min-h-[48px] items-center gap-3 py-1.5', off ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
                <input
                  type="checkbox"
                  {...field}
                  value={p.userId}
                  disabled={off}
                  className="h-5 w-5 shrink-0 rounded border-gray-300 accent-rsn-red"
                />
                <Avatar src={p.avatarUrl ?? undefined} name={name} size="sm" />
                <span className="min-w-0 truncate text-sm text-gray-800">{name}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
