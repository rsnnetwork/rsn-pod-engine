import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pre-fill the form (used by "Duplicate Pod") */
  initialValues?: Partial<PodForm>;
}

interface PodForm {
  name: string;
  description: string;
  podType: string;
  orchestrationMode: string;
  communicationMode: string;
  visibility: string;
  maxMembers: number | '';
}

const POD_TYPES = [
  { value: 'speed_networking',   label: 'Speed Networking',      desc: '1-on-1 timed rounds, structured networking' },
  { value: 'reason',             label: 'Reason Pod',            desc: 'People gathered for a shared purpose or cause' },
  { value: 'conversational',     label: 'Conversational',        desc: 'Small group open conversations' },
  { value: 'webinar',            label: 'Webinar',               desc: 'Presentation-style with a host speaker' },
  { value: 'physical_event',     label: 'Physical Event',        desc: 'In-person gathering supported digitally' },
  { value: 'chat',               label: 'Chat Pod',              desc: 'Text-based async community' },
  { value: 'two_sided_networking', label: 'Two-Sided Networking', desc: 'Two distinct groups meeting each other (e.g. founders ↔ investors)' },
  { value: 'one_sided_networking', label: 'One-Sided Networking', desc: 'One group networking among themselves' },
];

const VISIBILITY_OPTIONS = [
  { value: 'private',              label: 'Private',                desc: 'Invite only, hidden from browse' },
  { value: 'invite_only',          label: 'Invite Only',            desc: 'Discoverable but requires an invite link' },
  { value: 'public_with_approval', label: 'Public with Approval',   desc: 'Anyone can find and request to join; you approve' },
  { value: 'request_to_join',      label: 'Request to Join',        desc: 'Open requests with optional rules/agreement' },
  { value: 'public',               label: 'Public (Open Join)',      desc: 'Anyone can join immediately' },
];

const selectClass = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';

const DEFAULT_VALUES: PodForm = {
  name:              '',
  description:       '',
  podType:           'speed_networking',
  orchestrationMode: 'timed_rounds',
  communicationMode: 'video',
  visibility:        'private',
  maxMembers:        '',
};

export default function CreatePodModal({ open, onClose, initialValues }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<PodForm>({
    defaultValues: DEFAULT_VALUES,
  });

  // When initialValues change (e.g. duplicate pod opens), reset the form with new values
  useEffect(() => {
    if (open) {
      reset({ ...DEFAULT_VALUES, ...initialValues });
    }
  }, [open, initialValues, reset]);

  const mutation = useMutation({
    mutationFn: (data: PodForm) => api.post('/pods', {
      ...data,
      maxMembers: data.maxMembers === '' ? undefined : Number(data.maxMembers),
    }),
    onSuccess: (res) => {
      const newPodId = res.data?.data?.id;
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      addToast(initialValues ? 'Pod duplicated!' : 'Pod created!', 'success');
      reset(DEFAULT_VALUES);
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
          <select {...register('podType')} className={selectClass}>
            {POD_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Orchestration</label>
            <select {...register('orchestrationMode')} className={selectClass}>
              <option value="timed_rounds">Timed Rounds</option>
              <option value="free_form">Free Form</option>
              <option value="moderated">Moderated</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Communication</label>
            <select {...register('communicationMode')} className={selectClass}>
              <option value="video">Video</option>
              <option value="audio">Audio Only</option>
              <option value="text">Text</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
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
          />
        </div>

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
