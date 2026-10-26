import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { POD_TYPES } from '@rsn/shared';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { startingPodForm, afterTypeChange, orchestrationOptions, orchestrationLine, type PodForm } from './pod-form';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pre-fill the form (used by "Duplicate Pod") */
  initialValues?: Partial<PodForm>;
}

const VISIBILITY_OPTIONS = [
  { value: 'private',              label: 'Private',                desc: 'Invite only, hidden from browse' },
  { value: 'invite_only',          label: 'Invite Only',            desc: 'Discoverable but requires an invite link' },
  { value: 'public_with_approval', label: 'Public with Approval',   desc: 'Anyone can find and request to join; you approve' },
  { value: 'public',               label: 'Public (Open Join)',      desc: 'Anyone can join immediately' },
];

const selectClass = 'w-full min-h-[44px] rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';

export default function CreatePodModal({ open, onClose, initialValues }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { addToast } = useToastStore();

  // 26 Oct 2026 (Stefan and Claus, 25 Oct: "orchestration should follow the pod type"): what the type decides (how its
  // events run, what it communicates by) comes from the shared pod-type table, not from defaults written here. A
  // setting the member chooses by hand stays while a new type allows it; when it does not, it is replaced and the
  // member is told, under the field.
  // The form starts from the CONTENT of the pod to copy, not from the object: the pod page builds a new one each time it
  // draws, and a form that reset with each of them lost what the member was typing.
  const initialKey = JSON.stringify(initialValues ?? null);
  const start = useMemo(() => startingPodForm(JSON.parse(initialKey) ?? undefined), [initialKey]);
  const chosen = useRef(new Set(start.chosen));
  const [notices, setNotices] = useState(start.notices);

  const { register, handleSubmit, reset, watch, setValue, getValues, formState: { errors } } = useForm<PodForm>({
    defaultValues: start.values,
  });

  // Start clean, and start again when the form closes or the pod to copy changes. Never as it opens: that reset runs a
  // moment after the form is on screen, and could land after the first thing typed and wipe it (the form used to
  // reset on open, and lost a name typed at once 2 times in 20).
  useEffect(() => {
    if (open) return;
    chosen.current = new Set(start.chosen);
    setNotices(start.notices);
    reset(start.values);
  }, [open, start, reset]);

  const followType = (nextType: string) => {
    const next = afterTypeChange(getValues(), nextType, chosen.current);
    chosen.current = next.chosen;
    setValue('orchestrationMode', next.values.orchestrationMode);
    setValue('communicationMode', next.values.communicationMode);
    setNotices(next.notices);
  };

  const pickOrchestration = (mode: string) => {
    chosen.current.add('orchestrationMode');
    setValue('orchestrationMode', mode);
    setNotices([]);
  };

  const podType = watch('podType');
  const orchestration = watch('orchestrationMode');
  const modes = orchestrationOptions(podType);

  // When visibility flips to Public (Open Join), force allowMemberInvites=true.
  // Anyone can already join freely, so locking the toggle ON is consistent —
  // a member sending an invite is just a shortcut to the same outcome.
  // For other visibility levels (private / invite-only / public-with-approval),
  // the gate matters and the toggle stays user-controlled.
  const visibility = watch('visibility');
  const isPublicOpenJoin = visibility === 'public';
  useEffect(() => {
    if (isPublicOpenJoin) {
      setValue('allowMemberInvites', true);
    }
  }, [isPublicOpenJoin, setValue]);

  const mutation = useMutation({
    mutationFn: (data: PodForm) => api.post('/pods', {
      ...data,
      maxMembers: data.maxMembers === '' ? undefined : Number(data.maxMembers),
      // Public (Open Join) — coerce allowMemberInvites=true on submit even
      // if the user never toggled the checkbox.
      allowMemberInvites: data.visibility === 'public' ? true : !!data.allowMemberInvites,
    }),
    onSuccess: (res) => {
      const newPodId = res.data?.data?.id;
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      addToast(initialValues ? 'Pod duplicated!' : 'Pod created!', 'success');
      const fresh = startingPodForm();
      chosen.current = new Set(fresh.chosen);
      setNotices(fresh.notices);
      reset(fresh.values);
      onClose();
      if (newPodId && !initialValues) {
        navigate(`/pods/${newPodId}`);
      }
    },
    onError: () => addToast('Failed to create pod', 'error'),
  });

  const title = initialValues ? 'Duplicate Pod' : 'Create a Pod';

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4">
        <Input
          label="Pod Name"
          {...register('name', { required: 'Required' })}
          error={errors.name?.message}
          placeholder="e.g. Frontend Devs"
          className="min-h-[44px]"
        />

        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1.5">Description</label>
          <textarea
            {...register('description')}
            rows={2}
            placeholder="What is this pod about?"
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1.5">Pod Type</label>
          <select {...register('podType', { onChange: (e) => followType(e.target.value) })} className={selectClass}>
            {Object.entries(POD_TYPES).map(([value, rule]) => (
              <option key={value} value={value}>{rule.label} — {rule.summary}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={modes.length > 1 ? 'pod-orchestration-select' : undefined} className="block text-sm font-medium text-gray-600 mb-1.5">Orchestration</label>
          {modes.length > 1 ? (
            <select
              data-testid="pod-orchestration-select"
              id="pod-orchestration-select"
              value={orchestration}
              onChange={(e) => pickOrchestration(e.target.value)}
              className={selectClass}
            >
              {modes.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          ) : (
            <p
              data-testid="pod-orchestration"
              className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-600"
            >
              {orchestrationLine(orchestration)}
            </p>
          )}
          {notices.map(n => (
            <p key={n} role="status" data-testid="pod-orchestration-notice" className="mt-1.5 text-xs text-amber-700">{n}</p>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Visibility</label>
            <select {...register('visibility')} className={selectClass}>
              {VISIBILITY_OPTIONS.map(v => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </div>
          <Input
            label="Max Members (optional)"
            type="number"
            {...register('maxMembers', { valueAsNumber: false })}
            placeholder="Unlimited"
            className="min-h-[44px]"
          />
        </div>

        <label className={`flex items-center gap-3 ${isPublicOpenJoin ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={isPublicOpenJoin ? true : (watch('allowMemberInvites') || false)}
            onChange={(e) => { if (!isPublicOpenJoin) setValue('allowMemberInvites', e.target.checked); }}
            disabled={isPublicOpenJoin}
            className="h-4 w-4 rounded border-gray-300 text-[#1a1a2e] focus:ring-[#1a1a2e] disabled:opacity-60"
          />
          <span className="text-sm text-gray-600">
            Allow members to invite others
            {isPublicOpenJoin && (
              <span className="ml-2 text-xs text-gray-400">
                (always on for Public Open Join — anyone can join anyway)
              </span>
            )}
          </span>
        </label>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={mutation.isPending} className="btn-glow">
            {initialValues ? 'Duplicate Pod' : 'Create Pod'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
