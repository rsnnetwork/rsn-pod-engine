import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { ArrowLeft, Clock, Users, Settings, Radio } from 'lucide-react';
import api from '@/lib/api';

interface SessionForm {
  podId: string;
  title: string;
  description: string;
  scheduledAt: string;
  eventType: string;
  numberOfRounds: number;
  roundDurationSeconds: number;
  lobbyDurationSeconds: number;
  transitionDurationSeconds: number;
  maxParticipants: number;
  timerVisibility: string;
}

const EVENT_TYPES = [
  { value: 'speed_networking', label: 'Speed Networking', description: 'Timed 1-on-1 rounds with automatic matching' },
  { value: 'video_meeting', label: 'Video Meeting', description: 'Group video call with all participants' },
  { value: 'voice_meeting', label: 'Voice Meeting', description: 'Audio-only group call' },
  { value: 'webinar', label: 'Webinar', description: 'One-to-many presentation with Q&A' },
  { value: 'physical_event', label: 'Physical Event', description: 'In-person meetup with digital coordination' },
];

/** Returns current datetime rounded up to next 15-min slot, formatted for datetime-local input */
function getDefaultScheduledAt(): string {
  const now = new Date();
  const mins = now.getMinutes();
  const roundedMins = Math.ceil(mins / 15) * 15;
  now.setMinutes(roundedMins, 0, 0);
  if (roundedMins >= 60) now.setHours(now.getHours() + 1, 0, 0, 0);
  // Format as YYYY-MM-DDTHH:MM for datetime-local input
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const selectClass = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';

export default function CreateSessionPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { addToast } = useToastStore();
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const { data: allPods } = useQuery({
    queryKey: ['my-pods', isAdmin],
    queryFn: () => api.get(`/pods?status=active${isAdmin ? '&admin=true' : ''}`).then(r => r.data.data ?? []),
  });
  // Admins can create events in any pod; others need director/host role
  const pods = isAdmin ? (allPods || []) : (allPods || []).filter((p: any) => p.memberRole === 'director' || p.memberRole === 'host');

  const { register, handleSubmit, formState: { errors } } = useForm<SessionForm>({
    defaultValues: {
      podId: params.get('podId') || '',
      scheduledAt: getDefaultScheduledAt(),
      eventType: 'speed_networking',
      numberOfRounds: 5,
      roundDurationSeconds: 480,
      lobbyDurationSeconds: 480,
      transitionDurationSeconds: 30,
      maxParticipants: 500,
      timerVisibility: 'always_visible',
    },
  });

  const mutation = useMutation({
    mutationFn: (data: SessionForm) => {
      const body = {
        podId: data.podId,
        title: data.title,
        description: data.description || undefined,
        scheduledAt: new Date(data.scheduledAt).toISOString(),
        config: {
          eventType: data.eventType,
          numberOfRounds: data.numberOfRounds,
          roundDurationSeconds: data.roundDurationSeconds,
          lobbyDurationSeconds: data.lobbyDurationSeconds,
          transitionDurationSeconds: data.transitionDurationSeconds,
          maxParticipants: data.maxParticipants,
          timerVisibility: data.timerVisibility,
        },
      };
      return api.post('/sessions', body);
    },
    onSuccess: (res) => {
      addToast('Event scheduled!', 'success');
      navigate(`/sessions/${res.data.data?.id}`);
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error?.message || 'Failed to create event';
      addToast(msg, 'error');
    },
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <button onClick={() => navigate('/sessions')} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Events
      </button>

      <h1 className="text-2xl font-bold text-[#1a1a2e] animate-fade-in">Schedule an Event</h1>

      <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-6">
        {/* Basic Info */}
        <Card className="animate-fade-in-up">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Settings className="h-5 w-5 text-rsn-red" /> Basic Info
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Pod</label>
              <select
                {...register('podId', { required: 'Select a pod' })}
                className={selectClass}
              >
                <option value="">Select a pod</option>
                {(pods || []).map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {errors.podId && <p className="text-xs text-red-400 mt-1">{errors.podId.message}</p>}
            </div>
            <Input label="Title" {...register('title', { required: 'Required' })} placeholder="What will you discuss?" error={errors.title?.message} />
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Description (optional)</label>
              <textarea
                {...register('description')}
                rows={2}
                placeholder="Describe the event topic..."
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">
                <Radio className="h-4 w-4 inline mr-1.5 text-gray-400" />Event Type
              </label>
              <select {...register('eventType')} className={selectClass}>
                {EVENT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {EVENT_TYPES.find(t => t.value === 'speed_networking')?.description}
              </p>
            </div>
            <Input
              label="Scheduled At"
              type="datetime-local"
              {...register('scheduledAt', { required: 'Required' })}
              error={errors.scheduledAt?.message}
            />
          </div>
        </Card>

        {/* Session Config */}
        <Card className="animate-fade-in-up stagger-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Clock className="h-5 w-5 text-rsn-red" /> Timing Configuration
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Number of Rounds</label>
              <input type="number" {...register('numberOfRounds', { valueAsNumber: true, min: 1, max: 20 })} className={selectClass} />
              <p className="text-xs text-gray-400 mt-1">1 – 20 rounds</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Round Duration</label>
              <input type="number" {...register('roundDurationSeconds', { valueAsNumber: true, min: 60, max: 3600 })} className={selectClass} />
              <p className="text-xs text-gray-400 mt-1">60 – 3600 seconds (default 8 min)</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Break Between Rounds</label>
              <input type="number" {...register('transitionDurationSeconds', { valueAsNumber: true, min: 10, max: 120 })} className={selectClass} />
              <p className="text-xs text-gray-400 mt-1">Seconds participants wait between rounds (10 – 120)</p>
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
              <p className="text-xs text-gray-400 mt-1">When participants can see the countdown</p>
            </div>
          </div>
        </Card>

        {/* Capacity */}
        <Card className="animate-fade-in-up stagger-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Users className="h-5 w-5 text-rsn-red" /> Capacity
          </h2>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Max Participants</label>
            <input type="number" {...register('maxParticipants', { valueAsNumber: true, min: 2, max: 10000 })} className={selectClass} />
            <p className="text-xs text-gray-400 mt-1">2 – 10,000 participants</p>
          </div>
        </Card>

        <div className="flex gap-3 justify-end animate-fade-in-up stagger-3">
          <Button variant="ghost" type="button" onClick={() => navigate('/sessions')}>Cancel</Button>
          <Button type="submit" isLoading={mutation.isPending} className="btn-glow">Schedule Event</Button>
        </div>
      </form>
    </div>
  );
}
