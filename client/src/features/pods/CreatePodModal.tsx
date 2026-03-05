import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface Props { open: boolean; onClose: () => void; }

export default function CreatePodModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ name: string; description: string; maxMembers: number }>();

  const mutation = useMutation({
    mutationFn: (data: any) => api.post('/pods', data),
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
        <Input label="Description" {...register('description')} placeholder="e.g. React, Machine Learning" />
        <Input label="Max Members" type="number" {...register('maxMembers', { valueAsNumber: true })} placeholder="6" />
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" isLoading={mutation.isPending}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}
