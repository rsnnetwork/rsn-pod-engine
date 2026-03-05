import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface Props { open: boolean; onClose: () => void; }

export default function CreateInviteModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  const { data: pods } = useQuery({ queryKey: ['my-pods'], queryFn: () => api.get('/pods').then(r => r.data.data ?? []) });
  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ podId: string; maxUses: number }>();

  const mutation = useMutation({
    mutationFn: (data: any) => api.post('/invites', { ...data, type: 'pod' }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      addToast(`Invite created: ${res.data.data?.code || 'done'}`, 'success');
      reset();
      onClose();
    },
    onError: () => addToast('Failed to create invite', 'error'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Create Invite">
      <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1.5">Pod</label>
          <select
            {...register('podId', { required: 'Select a pod' })}
            className="w-full rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Select pod</option>
            {(pods || []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {errors.podId && <p className="text-xs text-red-400 mt-1">{errors.podId.message}</p>}
        </div>
        <Input label="Max Uses" type="number" {...register('maxUses', { valueAsNumber: true })} placeholder="10" />
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={mutation.isPending}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}
