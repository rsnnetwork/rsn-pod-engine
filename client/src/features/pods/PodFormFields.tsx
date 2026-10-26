// client/src/features/pods/PodFormFields.tsx
// The pod form's fields, one component for Create a Pod, Duplicate Pod and Edit Pod (26 Oct 2026), so the create
// and edit forms can no longer disagree (they did: units, defaults, a select the other lacked). The type and its
// orchestration are PodTypeFields; communication is not asked (it follows the type); Max members carries the type's
// recommended size ("Up to 12 recommended" for a Reason pod), never enforced.
import { useId, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { OrchestrationMode, PodType } from '@rsn/shared';
import Input from '@/components/ui/Input';
import PodTypeFields, { POD_FIELD, POD_LABEL } from './PodTypeFields';
import { POD_NAME_MAX, changeType, maxMembersProblem, podNameProblem, sizeHint, type PodFormValues } from './pod-type-form';

const VISIBILITY_OPTIONS = [
  { value: 'private', label: 'Private', desc: 'Invite only, hidden from browse' },
  { value: 'invite_only', label: 'Invite Only', desc: 'Discoverable but requires an invite link' },
  { value: 'public_with_approval', label: 'Public with Approval', desc: 'Anyone can find and request to join; you approve' },
  { value: 'public', label: 'Public (Open Join)', desc: 'Anyone can join immediately' },
];

const ERROR_LINE = 'text-xs text-red-400 mt-1';

interface Props {
  form: UseFormReturn<PodFormValues>;
  /** Settings the member (or the saved pod) chose: a change of type keeps them while the new type allows them. */
  chosen: ReadonlySet<string>;
  /** What opening the form changed (a duplicated old Reason pod read as Freeform). */
  initialNotices: string[];
  mode: 'create' | 'edit';
  /** Edit: the note about an old combination the form shows normalised. */
  legacyNote?: string | null;
}

export default function PodFormFields({ form, chosen: startChosen, initialNotices, mode, legacyNote }: Props) {
  const { register, watch, setValue, getValues, formState: { errors } } = form;
  const chosen = useRef(new Set(startChosen));
  const [notices, setNotices] = useState(initialNotices);
  // What the form opened with: the edit notes speak about it.
  const opened = useRef({ podType: getValues('podType'), orchestrationMode: getValues('orchestrationMode') });
  const descriptionId = useId();
  const visibilityId = useId();
  const rulesId = useId();

  const podType = watch('podType');
  const orchestrationMode = watch('orchestrationMode');
  const visibility = watch('visibility');
  const isPublicOpenJoin = visibility === 'public';
  const hint = sizeHint(podType);
  const typeChanged = mode === 'edit' && podType !== opened.current.podType;
  // "Saving changes it to Freeform" is true only while the type and the mode are the ones the form opened with.
  const legacyStillTrue = !typeChanged && orchestrationMode === opened.current.orchestrationMode;

  const onTypeChange = (next: PodType) => {
    const r = changeType(getValues(), next, chosen.current);
    setValue('podType', r.values.podType, { shouldDirty: true });
    setValue('orchestrationMode', r.values.orchestrationMode, { shouldDirty: true });
    setValue('communicationMode', r.values.communicationMode, { shouldDirty: true });
    setNotices(r.notices);
  };

  const onOrchestrationChange = (next: OrchestrationMode) => {
    chosen.current.add('orchestrationMode');
    setValue('orchestrationMode', next, { shouldDirty: true });
    setNotices([]);
  };

  return (
    <div className="grid gap-4">
      <Input
        label="Pod name"
        maxLength={POD_NAME_MAX}
        placeholder="e.g. Frontend Devs"
        error={errors.name?.message}
        {...register('name', { validate: (v) => podNameProblem(v) ?? true })}
      />

      <div>
        <label htmlFor={descriptionId} className={POD_LABEL}>Description <span className="font-normal text-gray-400">(optional)</span></label>
        <textarea
          id={descriptionId}
          rows={2}
          maxLength={2000}
          placeholder="What is this pod about?"
          className={`${POD_FIELD} resize-none`}
          aria-invalid={errors.description ? true : undefined}
          {...register('description')}
        />
        {errors.description && <p className={ERROR_LINE}>{errors.description.message}</p>}
      </div>

      <PodTypeFields
        podType={podType}
        orchestrationMode={orchestrationMode}
        onTypeChange={onTypeChange}
        onOrchestrationChange={onOrchestrationChange}
        notices={notices}
        legacyNote={legacyStillTrue ? legacyNote : null}
        typeChanged={typeChanged}
      />

      {/* One column on a phone: two selects side by side do not fit 360px. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={visibilityId} className={POD_LABEL}>Visibility</label>
          <select id={visibilityId} className={POD_FIELD} {...register('visibility')}>
            {VISIBILITY_OPTIONS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-gray-500">{VISIBILITY_OPTIONS.find((v) => v.value === visibility)?.desc}</p>
        </div>
        <div>
          <Input
            label="Max members (optional)"
            inputMode="numeric"
            placeholder="No limit"
            error={errors.maxMembers?.message}
            {...register('maxMembers', { validate: (v) => maxMembersProblem(v) ?? true })}
          />
          {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
        </div>
      </div>

      {mode === 'edit' && (
        <div>
          <label htmlFor={rulesId} className={POD_LABEL}>Pod rules <span className="font-normal text-gray-400">(optional)</span></label>
          <textarea
            id={rulesId}
            rows={2}
            maxLength={5000}
            placeholder="Community rules or guidelines shown to members"
            className={`${POD_FIELD} resize-none`}
            aria-invalid={errors.rules ? true : undefined}
            {...register('rules')}
          />
          {errors.rules && <p className={ERROR_LINE}>{errors.rules.message}</p>}
        </div>
      )}

      {/* Public (Open Join): anyone can join anyway, so members may always invite. */}
      <label className={`flex min-h-[44px] items-center gap-3 ${isPublicOpenJoin ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          checked={isPublicOpenJoin ? true : watch('allowMemberInvites')}
          onChange={(e) => { if (!isPublicOpenJoin) setValue('allowMemberInvites', e.target.checked, { shouldDirty: true }); }}
          disabled={isPublicOpenJoin}
          className="h-5 w-5 rounded border-gray-300 text-[#1a1a2e] focus:ring-[#1a1a2e] disabled:opacity-60"
        />
        <span className="text-sm text-gray-600">
          Allow members to invite others
          {isPublicOpenJoin && <span className="ml-2 text-xs text-gray-400">(always on for Public Open Join; anyone can join anyway)</span>}
        </span>
      </label>
    </div>
  );
}
