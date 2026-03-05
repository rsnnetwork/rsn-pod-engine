import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface SessionForm {
  podId: string;
  title: string;
  scheduledAt: string;
  roundDurationSeconds: number;
}

export default function CreateSessionPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { addToast } = useToastStore();

  const { data: pods } = useQuery({
    queryKey: ['my-pods'],
    queryFn: () => api.get('/pods').then(r => r.data.data ?? []),
  });

  const { register, handleSubmit, formState: { errors } } = useForm<SessionForm>({
    defaultValues: { podId: params.get('podId') || '', roundDurationSeconds: 300 },
  });

  const mutation = useMutation({
    mutationFn: (data: SessionForm) => {
      const body = {
        podId: data.podId,
        title: data.title,
        scheduledAt: new Date(data.scheduledAt).toISOString(),
        config: { roundDurationSeconds: data.roundDurationSeconds },
      };
      return api.post('/sessions', body);
    },
    onSuccess: (res) => {
      addToast('Session scheduled!', 'success');
      navigate(`/sessions/${res.data.data?.id}`);
    },
    onError: () => addToast('Failed to create session', 'error'),
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-surface-100">Schedule a Session</h1>
      <Card>
        <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Pod</label>
            <select
              {...register('podId', { required: 'Select a pod' })}
              className="w-full rounded-xl border border-surface-700 bg-surface-800/50 px-4 py-2.5 text-sm text-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Select a pod</option>
              {(pods || []).map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {errors.podId && <p className="text-xs text-red-400 mt-1">{errors.podId.message}</p>}
          </div>
          <Input label="Title" {...register('title', { required: 'Required' })} placeholder="What will you discuss?" error={errors.title?.message} />
          <Input label="Scheduled At" type="datetime-local" {...register('scheduledAt', { required: 'Required' })} error={errors.scheduledAt?.message} />
          <Input label="Round Duration (seconds)" type="number" {...register('roundDurationSeconds', { valueAsNumber: true })} />
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" type="button" onClick={() => navigate('/sessions')}>Cancel</Button>
            <Button type="submit" isLoading={mutation.isPending}>Schedule</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
