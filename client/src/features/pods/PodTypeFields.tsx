// client/src/features/pods/PodTypeFields.tsx
// What a pod's type decides, on the create and the edit form alike (26 Oct 2026): the type, with its one line from
// the shared table, and how its events run. A type with one orchestration says it in one line; a type with several
// offers only those. A change of type follows pod-type-form's changeType, so a mode the member chose is never
// replaced silently: the notice says what changed. Communication is not asked; it follows the type.
import { useId } from 'react';
import type { OrchestrationMode, PodType } from '@rsn/shared';
import { TYPE_CHANGE_NOTE, orchestrationChoice, podTypeChoices } from './pod-type-form';

/** A form control on the pod forms: 44px tall, the error border when it has one. */
export const POD_FIELD = 'w-full min-h-[44px] rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';
export const POD_LABEL = 'block text-sm font-medium text-gray-600 mb-1.5';
const NOTE = 'mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800';

interface Props {
  podType: PodType;
  orchestrationMode: OrchestrationMode;
  onTypeChange: (next: PodType) => void;
  onOrchestrationChange: (mode: OrchestrationMode) => void;
  /** What the last change of type did to a setting the member had chosen. */
  notices: string[];
  /** Edit: the note about an old combination the form shows normalised. */
  legacyNote?: string | null;
  /** Edit: the type differs from the saved one, so the form says scheduled events keep theirs. */
  typeChanged?: boolean;
}

export default function PodTypeFields({ podType, orchestrationMode, onTypeChange, onOrchestrationChange, notices, legacyNote, typeChanged }: Props) {
  const typeId = useId();
  const typeLine = useId();
  const modeId = useId();
  const modeLine = useId();
  const choices = podTypeChoices();
  const current = choices.find((c) => c.value === podType);
  const choice = orchestrationChoice(podType);

  return (
    <div className="grid gap-4">
      <div>
        <label htmlFor={typeId} className={POD_LABEL}>Pod type</label>
        <select
          id={typeId}
          value={podType}
          onChange={(e) => onTypeChange(e.target.value as PodType)}
          aria-describedby={typeLine}
          className={POD_FIELD}
        >
          {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <p id={typeLine} className="mt-1 text-xs text-gray-500">{current?.summary}</p>
      </div>

      <div>
        {choice.kind === 'line' ? (
          <>
            <p className={POD_LABEL}>Orchestration</p>
            <p className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700">{choice.text}</p>
          </>
        ) : (
          <>
            <label htmlFor={modeId} className={POD_LABEL}>Orchestration</label>
            <select
              id={modeId}
              value={orchestrationMode}
              onChange={(e) => onOrchestrationChange(e.target.value as OrchestrationMode)}
              aria-describedby={modeLine}
              className={POD_FIELD}
            >
              {choice.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p id={modeLine} className="mt-1 text-xs text-gray-500">
              {choice.options.find((o) => o.value === orchestrationMode)?.summary}
            </p>
          </>
        )}
        <div aria-live="polite">
          {notices.map((notice) => <p key={notice} className={NOTE}>{notice}</p>)}
          {legacyNote && <p className={NOTE}>{legacyNote}</p>}
          {typeChanged && <p className="mt-2 text-xs text-gray-500">{TYPE_CHANGE_NOTE}</p>}
        </div>
      </div>
    </div>
  );
}
