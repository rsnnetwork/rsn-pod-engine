// client/src/features/sessions/EventAccessField.tsx
// T11 (1 Nov 2026; L17) — "Who can join": three radio cards (Public with approval, Public, Private), labelled from
// the shared EVENT_ACCESS, with a line naming the pod's own setting. Used by Schedule an Event and Edit Event and sent
// as the top-level `visibility`. A fourth "invite only but listed" choice is not offered (audit 04 decision 5).
// T13 (1 Nov 2026): for an event for a whole circle, Private means the circle: its card says whose members.
import { useId } from 'react';
import { EVENT_ACCESS, EVENT_VISIBILITY_KEYS, type EventVisibility } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { EVENT_LABEL } from './EventFormatFields';
import { circlePrivateSummary } from './circle-preset';

const POD_ACCESS_WORDS: Record<string, string> = {
  public: 'Public',
  public_with_approval: 'Public with approval',
  invite_only: 'Invite only',
  private: 'Private',
};

/** The line under the cards: the pod's own setting, which is where the choice started. */
export function podAccessLine(podName: string | undefined, podVisibility: string | null | undefined): string | null {
  if (!podName || !podVisibility || !POD_ACCESS_WORDS[podVisibility]) return null;
  return `${podName} is ${POD_ACCESS_WORDS[podVisibility]}. This choice is for this event only.`;
}

interface Props {
  value: EventVisibility;
  onChange: (next: EventVisibility) => void;
  podName?: string;
  podVisibility?: string | null;
  /** Edit: going private removes nobody already registered, and the form says so. */
  editing?: boolean;
  /** T13: the circle the event is for, whose members Private means. */
  circleName?: string;
}

export default function EventAccessField({ value, onChange, podName, podVisibility, editing, circleName }: Props) {
  const name = useId();
  const podLine = podAccessLine(podName, podVisibility);
  return (
    <fieldset data-testid="event-access-field">
      <legend className={EVENT_LABEL}>Who can join</legend>
      <div className="grid gap-2 lg:grid-cols-3">
        {EVENT_VISIBILITY_KEYS.map((key) => {
          const rule = EVENT_ACCESS[key];
          const checked = value === key;
          return (
            <label
              key={key}
              data-testid={`event-access-${key}`}
              className={cn(
                'flex min-h-[44px] cursor-pointer gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                checked ? 'border-rsn-red bg-rsn-red/5' : 'border-gray-200 bg-white hover:border-gray-300',
              )}
            >
              <input
                type="radio"
                name={name}
                value={key}
                checked={checked}
                onChange={() => onChange(key)}
                className="mt-1 h-4 w-4 flex-shrink-0 accent-rsn-red"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-gray-900">{rule.label}</span>
                <span className="block text-xs text-gray-500 break-words">{key === 'private' && circleName ? circlePrivateSummary(circleName) : rule.summary}</span>
              </span>
            </label>
          );
        })}
      </div>
      {podLine && <p className="text-xs text-gray-500 mt-2">{podLine}</p>}
      {editing && <p className="text-xs text-gray-500 mt-1">Changing this removes nobody who is already registered.</p>}
    </fieldset>
  );
}
