import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface Props { open: boolean; onClose: () => void; }

interface PodForm {
  name: string;
  description: string;
  podType: string;
  orchestrationMode: string;
  communicationMode: string;
  visibility: string;
  maxMembers: number;
}

const podTypes = [
  { value: 'speed_networking', label: 'Speed Networking', desc: '1-on-1 timed rounds' },
  { value: 'duo', label: 'Duo', desc: '2-person conversations' },
  { value: 'trio', label: 'Trio', desc: '3-person groups' },
  { value: 'kvartet', label: 'Kvartet', desc: '4-person groups' },
  { value: 'band', label: 'Band', desc: 'Small group (5-8)' },
  { value: 'orchestra', label: 'Orchestra', desc: 'Medium group' },
  { value: 'concert', label: 'Concert', desc: 'Large audience' },
];

const selectClass = 'w-full rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all duration-200';

export default function CreatePodModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<PodForm>({
    defaultValues: {
      podType: 'speed_networking',
      orchestrationMode: 'timed_rounds',
      communicationMode: 'video',
      visibility: 'private',
      maxMembers: 50,
    },
  });

  const mutation = useMutation({
    mutationFn: (data: PodForm) => api.post('/pods', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      addToast('Pod created!', 'success');
      reset();
      onClose();
    },
    onError: () => addToast('Failed to create pod', 'error'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Create a Pod">
      <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4">
        <Input label="Pod Name" {...register('name', { required: 'Required' })} error={errors.name?.message} placeholder="e.g. Frontend Devs" />
        <Input label="Description" {...register('description')} placeholder="What is this pod about?" />

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1.5">Pod Type</label>
          <select {...register('podType')} className={selectClass}>
            {podTypes.map(t => (
              <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Orchestration</label>
            <select {...register('orchestrationMode')} className={selectClass}>
              <option value="timed_rounds">Timed Rounds</option>
              <option value="free_form">Free Form</option>
              <option value="moderated">Moderated</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Communication</label>
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
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Visibility</label>
            <select {...register('visibility')} className={selectClass}>
              <option value="private">Private</option>
              <option value="invite_only">Invite Only</option>
              <option value="public">Public</option>
            </select>
          </div>
          <Input label="Max Members" type="number" {...register('maxMembers', { valueAsNumber: true })} placeholder="50" />
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={mutation.isPending} className="btn-glow">Create Pod</Button>
        </div>
      </form>
    </Modal>
  );
}
