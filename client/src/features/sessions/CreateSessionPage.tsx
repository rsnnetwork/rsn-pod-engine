import { useForm } from 'react-hook-form';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  EVENT_FORMATS, EVENT_FORMAT_KEYS, applyFormatChange, checkEventInput, defaultEventFormat, defaultTitle,
  eventFormatsForPod, formatRefusal, liveKindOf,
} from '@rsn/shared';
import type { EventFormat, PodType } from '@rsn/shared';

// 26 Oct 2026 (Stefan and Claus, 25 Oct): "Video meeting. There's no timing configuration for a video meeting" — the
// form showed 5 rounds of 8 minutes and speed networking's description whatever was chosen, and offered formats the
// pod could not hold. It now reads the shared event-format table: the picker offers the formats the pod's type holds,
// the words under it are the chosen format's, the Timing card is for a rounds format and a meeting has a Length, the
// capacity limits are the format's, the title starts as "Video meeting · <pod>", and the body carries the format.

interface SessionForm {
  podId: string;
  title: string;
  description: string;
  scheduledAt: string;
  numberOfRounds: number;
  roundDurationSeconds: number;
  durationMinutes: number;
  maxParticipants: number;
  timerVisibility: string;
  matchingTemplateId: string;
  // Phase 4 (29 April 2026 spec) — three matching policies, default
  // 'within_event'. See shared/src/types/session.ts MatchingPolicy.
  matchingPolicy: 'platform_wide' | 'within_event' | 'none';
}

interface PodRow {
  id: string;
  name: string;
  podType: PodType;
  memberRole?: string | null;
}

const MATCHING_POLICIES = [
  {
    value: 'platform_wide' as const,
    label: 'Platform-wide no rematch',
    description: 'Strictest. If two people have ever met before anywhere on RSN, they will never be matched again.',
    hint: 'Best for large-scale discovery events.',
  },
  {
    value: 'within_event' as const,
    label: 'Within this event only',
    description: "If two people already met in THIS event, they won't be re-paired in this event. They can meet again in future events.",
    hint: 'Recommended default — balanced.',
  },
  {
    value: 'none' as const,
    label: 'No restriction',
    description: 'People can be matched again, even if they met before. Useful for smaller groups, curated sessions, or when repeated conversations are valuable.',
    hint: 'Best for small groups or repeat-attendance pods.',
  },
];

/** What the picker offers before a pod is chosen: every format that is on offer, never one that is only defined. */
const OFFERED_NOW: EventFormat[] = EVENT_FORMAT_KEYS.filter((f) => EVENT_FORMATS[f].available);

/** The lengths a meeting's picker lists, within the format's own limits. */
const MEETING_LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240];

/** The format the form is on: the one the organiser picked while the pod's type holds it, else the type's own default. */
function formatFor(picked: EventFormat | null, podType: PodType | undefined): EventFormat {
  if (!podType) return picked ?? 'speed_networking';
  return picked && eventFormatsForPod(podType).includes(picked) ? picked : defaultEventFormat(podType);
}

/** A setting's limits as a hint under it: "2 – 100 participants". */
function rangeHint(format: EventFormat, key: string, noun: string): string {
  const { min = 0, max = 0 } = EVENT_FORMATS[format].fields[key];
  return `${min.toLocaleString('en-US')} – ${max.toLocaleString('en-US')} ${noun}`;
}

/** The round length's limits in seconds, which is how this form takes it (the definition holds minutes). */
function roundSeconds(format: EventFormat): { min: number; max: number; defaultMinutes: number } {
  const { min = 1, max = 60, default: fallback = 8 } = EVENT_FORMATS[format].fields.roundMinutes ?? {};
  return { min: min * 60, max: max * 60, defaultMinutes: Number(fallback) };
}

/** The definition's own sentence for a setting out of range ("Number of rounds must be between 1 and 20."), else true. */
function fieldMessage(format: EventFormat, key: string, value: unknown): string | true {
  return checkEventInput(format, { [key]: value })[0]?.message ?? true;
}

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

const selectClass = 'w-full min-h-[44px] rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';

export default function CreateSessionPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { addToast } = useToastStore();
  const { user } = useAuthStore();
  const currentUserId = user?.id;
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const { data: allPods } = useQuery({
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
    () => (isAdmin ? (allPods ?? []) : (allPods ?? []).filter((p: PodRow) => p.memberRole === 'director' || p.memberRole === 'host')),
    [allPods, isAdmin],
  );

  const { register, handleSubmit, setValue, getValues, watch, formState: { errors } } = useForm<SessionForm>({
    defaultValues: {
      podId: params.get('podId') || '',
      title: defaultTitle('speed_networking', ''),
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

  // The pod's type decides which formats it holds. The list above is the first twenty pods, so a pod the address names
  // that it lacks is read by itself (the same read the pod's own page makes).
  const podId = watch('podId');
  const listedPod = pods.find((p) => p.id === podId);
  const { data: fetchedPod } = useQuery({
    queryKey: ['pod', podId],
    queryFn: () => api.get(`/pods/${podId}`).then(r => r.data.data),
    enabled: !!podId && !!allPods && !listedPod,
    meta: { entities: podId ? [E.pod(podId)] : [] },
  });
  const pod: PodRow | undefined = listedPod ?? fetchedPod;
  const podType = pod?.podType;

  // What the organiser picked, if anything. The format the form is on follows the pod until they pick one the pod holds.
  const [picked, setPicked] = useState<EventFormat | null>(null);
  const offered = podType ? eventFormatsForPod(podType) : OFFERED_NOW;
  const format = formatFor(picked, podType);
  const rounds = liveKindOf(format) === 'rounds';
  const fields = EVENT_FORMATS[format].fields;
  const switchedBecause = picked && podType && !offered.includes(picked)
    ? `Changed to ${EVENT_FORMATS[format].label}: ${(formatRefusal(podType, picked) ?? '').replace(/ Choose .*$/, '')}`
    : null;

  // Settings the organiser has typed in stay theirs; the others follow the format (the capacity of a meeting is not
  // the capacity of a speed-networking night), and a typed one the format does not allow is replaced, with a notice.
  const touched = useRef(new Set<string>());
  const lastFormat = useRef<EventFormat>(format);
  const [capacityNotices, setCapacityNotices] = useState<string[]>([]);
  useEffect(() => {
    const next = applyFormatChange({ format: lastFormat.current, maxParticipants: getValues('maxParticipants') }, format, touched.current);
    lastFormat.current = format;
    setValue('maxParticipants', next.values.maxParticipants);
    setCapacityNotices(next.notices);
  }, [format, getValues, setValue]);

  // The title starts as "Video meeting · Test" and follows the format and the pod until the organiser writes their own.
  const podName = pod?.name ?? '';
  useEffect(() => {
    if (!touched.current.has('title')) setValue('title', defaultTitle(format, podName));
  }, [format, podName, setValue]);

  const mutation = useMutation({
    mutationFn: (data: SessionForm & { format: EventFormat }) => {
      const body = {
        podId: data.podId,
        title: data.title,
        description: data.description || undefined,
        scheduledAt: new Date(data.scheduledAt).toISOString(),
        format: data.format,
        config: liveKindOf(data.format) === 'rounds'
          ? {
            eventType: data.format,
            numberOfRounds: data.numberOfRounds,
            roundDurationSeconds: data.roundDurationSeconds,
            maxParticipants: data.maxParticipants,
            timerVisibility: data.timerVisibility,
            matchingPolicy: data.matchingPolicy,
            ...(data.matchingTemplateId && { matchingTemplateId: data.matchingTemplateId }),
          }
          : {
            eventType: data.format,
            durationMinutes: data.durationMinutes,
            maxParticipants: data.maxParticipants,
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

  const roundLimits = roundSeconds(format);
  const meetingLengths = MEETING_LENGTHS.filter((n) => n >= (fields.durationMinutes?.min ?? 0) && n <= (fields.durationMinutes?.max ?? Infinity));
  const notices = [switchedBecause, ...capacityNotices].filter((n): n is string => !!n);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <button onClick={() => navigate('/sessions')} className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> Back to Events
      </button>

      <h1 className="text-2xl font-bold text-[#1a1a2e] animate-fade-in">Schedule an Event</h1>

      <form onSubmit={handleSubmit(d => mutation.mutate({ ...d, format }))} className="space-y-6">
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
                {pods.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {errors.podId && <p className="text-xs text-red-400 mt-1">{errors.podId.message}</p>}
            </div>
            <Input
              label="Title"
              {...register('title', { required: 'Required', onChange: () => touched.current.add('title') })}
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
              {offered.length > 1 ? (
                <select
                  data-testid="event-format-select"
                  id="event-format"
                  value={format}
                  onChange={(e) => setPicked(e.target.value as EventFormat)}
                  className={selectClass}
                >
                  {offered.map((f) => (
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
              {notices.map((n) => (
                <p key={n} role="status" data-testid="event-format-notice" className="mt-1.5 text-xs text-amber-700">{n}</p>
              ))}
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

        {rounds ? (
          /* Session Config — speed networking runs on rounds */
          <Card className="animate-fade-in-up stagger-1" data-testid="timing-card">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
              <Clock className="h-5 w-5 text-rsn-red" /> Timing Configuration
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Number of Rounds</label>
                <input
                  type="number"
                  {...register('numberOfRounds', { valueAsNumber: true, validate: (v) => fieldMessage(format, 'numberOfRounds', v) })}
                  className={selectClass}
                />
                {errors.numberOfRounds && <p className="text-xs text-red-400 mt-1">{errors.numberOfRounds.message}</p>}
                <p className="text-xs text-gray-400 mt-1">{rangeHint(format, 'numberOfRounds', 'rounds')}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Round Duration</label>
                <input
                  type="number"
                  {...register('roundDurationSeconds', {
                    valueAsNumber: true,
                    validate: (v) => (v >= roundLimits.min && v <= roundLimits.max) || `Round duration must be between ${roundLimits.min} and ${roundLimits.max} seconds.`,
                  })}
                  className={selectClass}
                />
                {errors.roundDurationSeconds && <p className="text-xs text-red-400 mt-1">{errors.roundDurationSeconds.message}</p>}
                <p className="text-xs text-gray-400 mt-1">{roundLimits.min} – {roundLimits.max} seconds (default {roundLimits.defaultMinutes} min)</p>
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
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1.5">Matching Template</label>
                <select {...register('matchingTemplateId')} className={selectClass}>
                  <option value="">Default (balanced)</option>
                  {(templates || []).map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">How participants are matched — affects scoring weights</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-2">Matching Policy</label>
                <p className="text-xs text-gray-500 mb-3">
                  Control whether people who&apos;ve met before can be paired again.
                </p>
                <div className="space-y-2">
                  {MATCHING_POLICIES.map(p => (
                    <label
                      key={p.value}
                      className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer hover:border-gray-300 transition-colors"
                    >
                      <input
                        type="radio"
                        value={p.value}
                        {...register('matchingPolicy')}
                        className="mt-0.5 accent-[#1a1a2e]"
                      />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-[#1a1a2e]">{p.label}</div>
                        <div className="text-xs text-gray-600 mt-0.5">{p.description}</div>
                        <div className="text-xs text-gray-400 mt-1 italic">{p.hint}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </Card>
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
                {meetingLengths.map((n) => (
                  <option key={n} value={n}>{n} min</option>
                ))}
              </select>
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
                onChange: () => touched.current.add('maxParticipants'),
                validate: (v) => fieldMessage(format, 'maxParticipants', v),
              })}
              className={selectClass}
            />
            {errors.maxParticipants && <p className="text-xs text-red-400 mt-1">{errors.maxParticipants.message}</p>}
            <p className="text-xs text-gray-400 mt-1">{rangeHint(format, 'maxParticipants', 'participants')}</p>
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
