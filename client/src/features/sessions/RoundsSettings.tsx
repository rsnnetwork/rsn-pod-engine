import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { Clock } from 'lucide-react';
import Card from '@/components/ui/Card';
import type { EventFormat } from '@rsn/shared';
import { fieldMessage, rangeHint, roundSeconds } from './event-form';
import type { SessionForm } from './event-form';
import { FieldError, selectClass } from './form-parts';

// The settings of an event that runs on rounds (speed networking): how many, how long, the timer, how people are
// matched. A meeting has none of these (it has a length), so the page draws this card only for a rounds format.

const MATCHING_POLICIES = [
  {
    value: 'platform_wide' as const,
    label: 'Platform-wide no rematch',
    description: 'Strictest. If two people have ever met before anywhere on RSN, they will never be matched again.',
    hint: 'Best for large-scale discovery events.',
  },
  {
    value: 'within_event' as const,
    label: 'Within this event only',
    description: "If two people already met in THIS event, they won't be re-paired in this event. They can meet again in future events.",
    hint: 'Recommended default — balanced.',
  },
  {
    value: 'none' as const,
    label: 'No restriction',
    description: 'People can be matched again, even if they met before. Useful for smaller groups, curated sessions, or when repeated conversations are valuable.',
    hint: 'Best for small groups or repeat-attendance pods.',
  },
];

export interface MatchingTemplate {
  id: string;
  name: string;
  isDefault?: boolean;
}

interface Props {
  format: EventFormat;
  register: UseFormRegister<SessionForm>;
  errors: FieldErrors<SessionForm>;
  templates: MatchingTemplate[];
}

export default function RoundsSettings({ format, register, errors, templates }: Props) {
  const roundLimits = roundSeconds(format);

  return (
    /* Session Config — speed networking runs on rounds */
    <Card className="animate-fade-in-up stagger-1" data-testid="timing-card">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
        <Clock className="h-5 w-5 text-rsn-red" /> Timing Configuration
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1.5">Number of Rounds</label>
          <input
            type="number"
            {...register('numberOfRounds', { valueAsNumber: true, validate: (v) => fieldMessage(format, 'numberOfRounds', v) })}
            className={selectClass}
          />
          <FieldError message={errors.numberOfRounds?.message} />
          <p className="text-xs text-gray-400 mt-1">{rangeHint(format, 'numberOfRounds', 'rounds')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1.5">Round Duration</label>
          <input
            type="number"
            {...register('roundDurationSeconds', {
              valueAsNumber: true,
              validate: (v) => (v >= roundLimits.min && v <= roundLimits.max) || `Round duration must be between ${roundLimits.min} and ${roundLimits.max} seconds.`,
            })}
            className={selectClass}
          />
          <FieldError message={errors.roundDurationSeconds?.message} />
          <p className="text-xs text-gray-400 mt-1">{roundLimits.min} – {roundLimits.max} seconds (default {roundLimits.defaultMinutes} min)</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1.5">Timer Visibility</label>
          <select {...register('timerVisibility')} className={selectClass}>
            <option value="always_visible">Always visible</option>
            <option value="hidden">Hidden</option>
            <option value="last_10s">Show last 10 seconds</option>
            <option value="last_30s">Show last 30 seconds</option>
            <option value="last_60s">Show last 60 seconds</option>
            <option value="last_120s">Show last 2 minutes</option>
          </select>
          <FieldError message={errors.timerVisibility?.message} />
          <p className="text-xs text-gray-400 mt-1">When participants can see the countdown</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1.5">Matching Template</label>
          <select {...register('matchingTemplateId')} className={selectClass}>
            <option value="">Default (balanced)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">How participants are matched — affects scoring weights</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">Matching Policy</label>
          <p className="text-xs text-gray-500 mb-3">
            Control whether people who&apos;ve met before can be paired again.
          </p>
          <div className="space-y-2">
            {MATCHING_POLICIES.map(p => (
              <label
                key={p.value}
                className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer hover:border-gray-300 transition-colors"
              >
                <input
                  type="radio"
                  value={p.value}
                  {...register('matchingPolicy')}
                  className="mt-0.5 accent-[#1a1a2e]"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-[#1a1a2e]">{p.label}</div>
                  <div className="text-xs text-gray-600 mt-0.5">{p.description}</div>
                  <div className="text-xs text-gray-400 mt-1 italic">{p.hint}</div>
                </div>
              </label>
            ))}
          </div>
          <FieldError message={errors.matchingPolicy?.message} />
        </div>
      </div>
    </Card>
  );
}
