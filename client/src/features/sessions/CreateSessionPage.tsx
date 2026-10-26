import { useForm } from 'react-hook-form';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { ArrowLeft, Clock, Users, Settings, Radio } from 'lucide-react';
import api from '@/lib/api';
import { localTimezoneLabel } from '@/lib/utils';
import { E } from '@/realtime/entities';
import { EVENT_FORMATS, liveKindOf } from '@rsn/shared';
import type { EventFormat } from '@rsn/shared';
import { fieldMessage, maySchedule, meetingLengthsFor, namedPodOffer, podOptions, rangeHint, serverFieldErrors, sessionBody } from './event-form';
import type { PodRow, SessionForm } from './event-form';
import { FieldError, selectClass } from './form-parts';
import RoundsSettings from './RoundsSettings';
import type { MatchingTemplate } from './RoundsSettings';
import { useEventFormat } from './useEventFormat';

// 26 Oct 2026 (Stefan and Claus, 25 Oct): "Video meeting. There's no timing configuration for a video meeting" — the
// form showed 5 rounds of 8 minutes and speed networking's description whatever was chosen, and offered formats the
// pod could not hold. It now reads the shared event-format table (event-form.ts holds the rules, useEventFormat.ts the
// state, RoundsSettings.tsx the rounds card): the picker offers the formats the pod's type holds, the words under it
// are the chosen format's, the rounds card is for a rounds format and a meeting has a Length, the capacity limits are
// the format's, the title starts as "Video meeting · <pod>", and the body carries the format. A refusal from the
// server is said at its own field.

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

/** Held where the format's picker goes while the pod's type is not known: it is not guessed, then swapped. */
function FormatPending() {
  return (
    <div data-testid="format-pending" role="status" aria-busy="true" className="animate-pulse space-y-2">
      <span className="sr-only">Loading this pod&apos;s event types</span>
      <div className="h-[44px] rounded-xl bg-gray-100" />
      <div className="h-3 w-2/3 rounded bg-gray-100" />
    </div>
  );
}

/** Held where the format's own settings and the capacity go, for the same reason. */
function SettingsPending() {
  return (
    <Card className="animate-fade-in-up stagger-1" data-testid="settings-pending">
      <div role="status" aria-busy="true" className="animate-pulse space-y-3">
        <span className="sr-only">Loading this pod&apos;s event settings</span>
        <div className="h-6 w-1/3 rounded bg-gray-100" />
        <div className="h-[44px] rounded-xl bg-gray-100" />
        <div className="h-[44px] rounded-xl bg-gray-100" />
        <div className="h-[44px] rounded-xl bg-gray-100" />
      </div>
    </Card>
  );
}

export default function CreateSessionPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { addToast } = useToastStore();
  const { user } = useAuthStore();
  const currentUserId = user?.id;
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const { data: allPods, isLoading: podsLoading } = useQuery({
    queryKey: ['my-pods', isAdmin],
    queryFn: () => api.get(`/pods?status=active${isAdmin ? '&admin=true' : ''}`).then(r => r.data.data ?? []),
    meta: { entities: currentUserId ? [E.userPods(currentUserId)] : [] },
  });
  const { data: templates } = useQuery({
    queryKey: ['matching-templates'],
    queryFn: () => api.get('/admin/templates').then(r => r.data.data ?? []),
  });

  // Admins can create events in any pod; others need director/host role. Kept as one array until the list or the role
  // changes: filtering afresh on every render gave anything that depended on it a new value each time.
  const pods = useMemo<PodRow[]>(
    () => (allPods ?? []).filter((p: PodRow) => maySchedule(p, isAdmin)),
    [allPods, isAdmin],
  );

  const urlPodId = params.get('podId') || '';
  const { register, handleSubmit, setValue, getValues, setError, watch, formState: { errors } } = useForm<SessionForm>({
    defaultValues: {
      podId: urlPodId,
      // Filled in once the format is known (useEventFormat), never with a guess that is then replaced.
      title: '',
      scheduledAt: getDefaultScheduledAt(),
      numberOfRounds: 5,
      roundDurationSeconds: 480,
      durationMinutes: Number(EVENT_FORMATS.video_meeting.fields.durationMinutes.default),
      maxParticipants: 500,
      timerVisibility: 'always_visible',
      matchingTemplateId: '',
      matchingPolicy: 'within_event',
    },
  });

  // The list above is the server's first page, the twenty newest pods, so a pod the address names can fall outside it (an
  // older one, which the pod page links to). It is read by itself (the same read the pod's own page makes), for its type
  // and its name, and offered in the select so it can be chosen and the form submitted. The read is keyed by the address's
  // pod, not the chosen one: choosing another pod does not take it out of the select.
  const podId = watch('podId');
  const { data: namedPod, isLoading: namedPodLoading } = useQuery({
    queryKey: ['pod', urlPodId],
    queryFn: () => api.get(`/pods/${urlPodId}`).then(r => r.data.data),
    enabled: !!urlPodId && !!allPods && !pods.some((p) => p.id === urlPodId),
    retry: false,
    meta: { entities: urlPodId ? [E.pod(urlPodId)] : [] },
  });
  const options = useMemo(() => podOptions(pods, namedPodOffer(namedPod, isAdmin)), [pods, namedPod, isAdmin]);

  // The pod's type decides which formats it holds.
  const pod = options.find((p) => p.id === podId);
  // A pod is chosen and we are still finding out what it is. (A pod that cannot be read, or one the member may not
  // schedule in, ends this: the form carries on with the formats on offer.)
  const podPending = !!podId && !pod && (podsLoading || namedPodLoading);

  const ev = useEventFormat({ podType: pod?.podType, podName: pod?.name ?? '', pending: podPending, getValues, setValue });
  const { format } = ev;
  const [formatError, setFormatError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: SessionForm & { format: EventFormat }) => api.post('/sessions', sessionBody(data)),
    onSuccess: (res) => {
      addToast('Event scheduled!', 'success');
      navigate(`/sessions/${res.data.data?.id}`);
    },
    onError: (err: unknown) => {
      // The server says which setting it refused: say it there. A toast only for what has no field to be said at.
      const refused = serverFieldErrors(err);
      setFormatError(refused.format);
      refused.fields.forEach((f, i) => setError(f.name, { type: 'server', message: f.message }, { shouldFocus: i === 0 }));
      if (refused.toast) addToast(refused.toast, 'error');
    },
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <button onClick={() => navigate('/sessions')} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Events
      </button>

      <h1 className="text-2xl font-bold text-[#1a1a2e] animate-fade-in">Schedule an Event</h1>

      <form
        onSubmit={handleSubmit(d => {
          setFormatError(null);
          mutation.mutate({ ...d, format });
        })}
        className="space-y-6"
      >
        {/* Basic Info */}
        <Card className="animate-fade-in-up">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
            <Settings className="h-5 w-5 text-rsn-red" /> Basic Info
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1.5">Pod</label>
              {/* Controlled by the form's podId: a pod named in the address shows once its option arrives, with no effect
                  to push it in. (An effect that did, watching a value it set and a list it rebuilt, ran after every render.) */}
              <select
                {...register('podId', { required: 'Select a pod' })}
                value={podId}
                className={selectClass}
              >
                <option value="">Select a pod</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <FieldError message={errors.podId?.message} />
            </div>
            <Input
              label="Title"
              {...register('title', { required: 'Required', onChange: () => ev.touch('title') })}
              placeholder="What will you discuss?"
              error={errors.title?.message}
              className="min-h-[44px]"
            />
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
              <label htmlFor="event-format" className="block text-sm font-medium text-gray-600 mb-1.5">
                <Radio className="h-4 w-4 inline mr-1.5 text-gray-400" />Event Type
              </label>
              {podPending ? (
                <FormatPending />
              ) : (
                <>
                  {ev.offered.length > 1 ? (
                    <select
                      data-testid="event-format-select"
                      id="event-format"
                      value={format}
                      onChange={(e) => {
                        setFormatError(null);
                        ev.pick(e.target.value as EventFormat);
                      }}
                      className={selectClass}
                    >
                      {ev.offered.map((f) => (
                        <option key={f} value={f}>{EVENT_FORMATS[f].label}</option>
                      ))}
                    </select>
                  ) : (
                    <p
                      data-testid="event-format-fixed"
                      className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-medium text-[#1a1a2e]"
                    >
                      {EVENT_FORMATS[format].label}
                    </p>
                  )}
                  <p data-testid="event-format-summary" className="text-xs text-gray-500 mt-1">
                    {EVENT_FORMATS[format].summary}
                  </p>
                  {ev.switched && (
                    <p role="status" data-testid="event-format-notice" className="mt-1.5 text-xs text-amber-700">{ev.switched}</p>
                  )}
                  <FieldError message={formatError ?? undefined} />
                </>
              )}
            </div>
            <div>
              <Input
                label="Scheduled At"
                type="datetime-local"
                {...register('scheduledAt', { required: 'Required' })}
                error={errors.scheduledAt?.message}
                className="min-h-[44px]"
              />
              <p className="text-xs text-gray-400 mt-1">
                Shown in your local time — {localTimezoneLabel()}. Each person sees the event in their own timezone.
              </p>
            </div>
          </div>
        </Card>

        {podPending ? (
          <SettingsPending />
        ) : (
          <>
            {liveKindOf(format) === 'rounds' ? (
              <RoundsSettings format={format} register={register} errors={errors} templates={(templates ?? []) as MatchingTemplate[]} />
            ) : (
              /* A meeting has no rounds: everyone is in one room until the host ends it, for about this long */
              <Card className="animate-fade-in-up stagger-1" data-testid="meeting-card">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
                  <Clock className="h-5 w-5 text-rsn-red" /> Meeting Length
                </h2>
                <div>
                  <label htmlFor="meeting-length" className="block text-sm font-medium text-gray-600 mb-1.5">Length</label>
                  <select
                    data-testid="meeting-length"
                    id="meeting-length"
                    {...register('durationMinutes', { valueAsNumber: true })}
                    className={selectClass}
                  >
                    {meetingLengthsFor(format).map((n) => (
                      <option key={n} value={n}>{n} min</option>
                    ))}
                  </select>
                  <FieldError message={errors.durationMinutes?.message} />
                  <p className="text-xs text-gray-400 mt-1">{rangeHint(format, 'durationMinutes', 'minutes')}</p>
                </div>
              </Card>
            )}

            {/* Capacity */}
            <Card className="animate-fade-in-up stagger-2" data-testid="capacity-card">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
                <Users className="h-5 w-5 text-rsn-red" /> Capacity
              </h2>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Max Participants</label>
                <input
                  type="number"
                  {...register('maxParticipants', {
                    valueAsNumber: true,
                    onChange: () => ev.touch('maxParticipants'),
                    validate: (v) => fieldMessage(format, 'maxParticipants', v),
                  })}
                  className={selectClass}
                />
                <FieldError message={errors.maxParticipants?.message} />
                {ev.capacityNotices.map((n) => (
                  <p key={n} role="status" data-testid="capacity-notice" className="mt-1.5 text-xs text-amber-700">{n}</p>
                ))}
                <p className="text-xs text-gray-400 mt-1">{rangeHint(format, 'maxParticipants', 'participants')}</p>
              </div>
            </Card>
          </>
        )}

        <div className="flex gap-3 justify-end animate-fade-in-up stagger-3">
          <Button variant="ghost" type="button" onClick={() => navigate('/sessions')}>Cancel</Button>
          <Button type="submit" isLoading={mutation.isPending} className="btn-glow">Schedule Event</Button>
        </div>
      </form>
    </div>
  );
}
