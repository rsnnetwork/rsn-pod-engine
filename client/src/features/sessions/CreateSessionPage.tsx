// client/src/features/sessions/CreateSessionPage.tsx
// Schedule an Event (26 Oct 2026). The form follows the event type and the event types follow the pod, both from
// the shared definition the server enforces: a Video meeting shows a length and a capacity, Speed networking its
// rounds. Arriving from a pod (?podId=) the pod is a read-only header. The title is filled in ("Video meeting · Test")
// and every problem is said at its field, with a summary beside the sticky submit. A new event opens with ?invite=1.
//
// 25 Oct walkthrough: the form defaulted to speed networking whatever the pod, a "Video meeting" was created with five
// 8-minute rounds, and the title's "Required" sat three screens above the button on a phone.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Settings } from 'lucide-react';
import { POD_TYPES, defaultTitle } from '@rsn/shared';
import type { EventFormat, OrchestrationMode, PodType } from '@rsn/shared';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import FormSummary from '@/components/ui/FormSummary';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api';
import { cn, isAdmin as isAdminRole, localTimezoneLabel } from '@/lib/utils';
import { E } from '@/realtime/entities';
import EventFormatFields, { EVENT_FIELD, EVENT_LABEL, EventTypePicker, FIELD_SCROLL_MARGINS, fieldBorder, type TemplateOption } from './EventFormatFields';
import {
  DESCRIPTION_MAX, TITLE_MAX, autoTitle, eventBody, newEventSchema, newEventValues, nextQuarterHour, offeredFormats,
  podChangeFormat, shownEventKeys, type EventPod, type NewEventBody,
} from './event-format-form';
import { useEventFormatForm } from './useEventFormatForm';

interface PodRow {
  id: string;
  name: string;
  podType: PodType;
  orchestrationMode?: OrchestrationMode | null;
  memberRole?: string | null;
  status?: string;
}

const CREATE_COPY = {
  fallback: 'Could not schedule the event just now. Try again in a moment.',
  forbidden: "Only the pod's director or a host can schedule events in this pod.",
  notFound: 'This pod could not be found. It may have been archived.',
};

const canSchedule = (pod: PodRow, isAdmin: boolean) => isAdmin || pod.memberRole === 'director' || pod.memberRole === 'host';
const toEventPod = (pod: PodRow | null): EventPod | null =>
  (pod ? { id: pod.id, name: pod.name, podType: pod.podType, orchestrationMode: pod.orchestrationMode } : null);
const statusOf = (err: unknown) => (err as { response?: { status?: number } } | null)?.response?.status;

export default function CreateSessionPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromPodId = params.get('podId');
  const user = useAuthStore((s) => s.user);
  const userId = user?.id as string | undefined;
  const isAdmin = isAdminRole(user?.role);

  const podQuery = useQuery({
    queryKey: ['pod', fromPodId],
    queryFn: () => api.get(`/pods/${fromPodId}`).then((r) => r.data.data as PodRow),
    enabled: !!fromPodId,
    retry: (failureCount, err) => statusOf(err) !== 404 && failureCount < 2,
    meta: { entities: fromPodId ? [E.pod(fromPodId)] : [] },
  });
  // Without ?podId= the organiser picks one of the pods they direct or host (admins: any). 100 is the API's page cap.
  const podsQuery = useQuery({
    queryKey: ['my-pods', 'schedulable', isAdmin],
    queryFn: () => api.get(`/pods?status=active&pageSize=100${isAdmin ? '&admin=true' : ''}`).then((r) => (r.data.data ?? []) as PodRow[]),
    enabled: !fromPodId,
    meta: { entities: [...(userId ? [E.userPods(userId)] : []), ...(isAdmin ? [E.adminPods] : [])] },
  });
  // The matching template is an admin pick, and /admin/templates is the one endpoint that lists templates.
  const templatesQuery = useQuery({
    queryKey: ['admin-templates'],
    queryFn: () => api.get('/admin/templates').then((r) => (r.data.data ?? []) as TemplateOption[]),
    enabled: isAdmin,
  });

  const pod = podQuery.data;
  const back = fromPodId ? `/pods/${fromPodId}` : '/sessions';
  const backLabel = fromPodId ? (pod ? `Back to ${pod.name}` : 'Back to Pod') : 'Back to Events';
  const formProps = { isAdmin, templates: templatesQuery.data, templatesLoading: isAdmin && templatesQuery.isLoading, back };

  let body: ReactNode;
  if (fromPodId) {
    if (podQuery.isLoading) body = <FormSkeleton />;
    else if (!pod) {
      body = (
        <Notice
          title="We couldn't open that pod"
          text="It may have been archived, or you may no longer be a member. You can still schedule an event in another pod."
          action={{ label: 'Choose a pod', onClick: () => navigate('/sessions/new') }}
        />
      );
    } else if (pod.status && pod.status !== 'active') {
      // The pod page offers "Schedule Event" only on an active pod; a link from elsewhere is told why not.
      body = (
        <Notice
          title={`${pod.name} is not active`}
          text="Events can be scheduled in an active pod. Its director can reactivate it from the pod page."
          action={{ label: `Back to ${pod.name}`, onClick: () => navigate(back) }}
        />
      );
    } else if (!canSchedule(pod, isAdmin)) {
      body = (
        <Notice
          title="Only the pod's director or a host can schedule events here"
          text={`Ask the director of ${pod.name} to schedule it, or to make you a host.`}
          action={{ label: `Back to ${pod.name}`, onClick: () => navigate(back) }}
        />
      );
    } else body = <NewEventForm fixedPod={pod} pods={[]} {...formProps} />;
  } else if (podsQuery.isLoading) {
    body = <FormSkeleton />;
  } else if (podsQuery.isError) {
    body = (
      <Notice
        title="We couldn't load your pods"
        text="Check your connection and try again."
        action={{ label: 'Try again', onClick: () => { podsQuery.refetch(); } }}
      />
    );
  } else {
    const schedulable = (podsQuery.data ?? []).filter((p) => canSchedule(p, isAdmin));
    body = schedulable.length === 0 ? (
      <Notice
        title="No pod to schedule in yet"
        text="Events are scheduled in a pod you direct or host. Create a pod, or ask a pod's director to make you a host."
        action={{ label: 'Go to your pods', onClick: () => navigate('/pods') }}
      />
    ) : <NewEventForm pods={schedulable} {...formProps} />;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <button onClick={() => navigate(back)} className="flex min-h-[44px] items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors text-sm">
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </button>
      <h1 className="text-2xl font-bold text-[#1a1a2e] animate-fade-in">Schedule an Event</h1>
      {body}
    </div>
  );
}

function FormSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-4">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="h-5 w-32 animate-pulse rounded bg-gray-200" />
          <div className="mt-5 h-11 animate-pulse rounded-xl bg-gray-100" />
          <div className="mt-3 h-11 animate-pulse rounded-xl bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

function Notice({ title, text, action }: { title: string; text: string; action: { label: string; onClick: () => void } }) {
  return (
    <Card className="animate-fade-in-up">
      <h2 className="text-lg font-semibold text-[#1a1a2e]">{title}</h2>
      <p className="mt-1 text-sm text-gray-500">{text}</p>
      <Button variant="secondary" className="mt-4" onClick={action.onClick}>{action.label}</Button>
    </Card>
  );
}

interface FormProps {
  /** The pod the form came from (?podId=): a header, not a choice. */
  fixedPod?: PodRow;
  /** The pods to choose from when there is no fixed pod. */
  pods: PodRow[];
  isAdmin: boolean;
  templates?: TemplateOption[];
  templatesLoading: boolean;
  back: string;
}

function NewEventForm({ fixedPod, pods, isAdmin, templates, templatesLoading, back }: FormProps) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const podFieldId = useId();
  const descriptionId = useId();
  const [start] = useState(() => newEventValues({ pod: toEventPod(fixedPod ?? null), scheduledAt: nextQuarterHour(new Date()) }));
  const lastAutoTitle = useRef(start.title);
  const ev = useEventFormatForm({
    defaultValues: start,
    schema: newEventSchema,
    copy: CREATE_COPY,
    shownKeys: (f) => [...(fixedPod ? [] : ['podId']), ...shownEventKeys(f, isAdmin)],
    onSwitched: (f) => refreshTitle(f),
  });
  const { register, watch, setValue, getValues, clearErrors, formState: { errors } } = ev.form;
  const podOf = (id: string) => fixedPod ?? pods.find((p) => p.id === id) ?? null;
  const pod = podOf(watch('podId'));

  /** The filled-in title follows the type and the pod until the member writes their own. */
  function refreshTitle(nextFormat: EventFormat) {
    const auto = defaultTitle(nextFormat, podOf(getValues('podId'))?.name ?? '');
    const next = autoTitle(getValues('title'), lastAutoTitle.current, auto);
    lastAutoTitle.current = auto;
    if (next !== getValues('title')) {
      setValue('title', next);
      clearErrors('title');
    }
  }

  /** A pod chosen (or its type changed while the form is open): the type follows it, with a notice when it must change. */
  const followPod = (nextPod: PodRow | null, chosen: boolean) => {
    const { format: next, notice } = podChangeFormat(getValues('format'), toEventPod(nextPod), chosen);
    ev.followFormat(next, notice);
  };

  // The pod's type can change while the form is open (its director edits it; the pod query is told at once): a type
  // the pod no longer holds is switched, and the organiser is told.
  const podType = pod?.podType;
  useEffect(() => {
    if (podType && !offeredFormats(podType).includes(getValues('format'))) followPod(pod, true);
    // Only a change of the pod's type matters here; the form's own state is read when it runs.
  }, [podType]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useMutation({
    networkMode: 'always',
    mutationFn: (body: NewEventBody) => api.post('/sessions', body),
    onSuccess: (res) => {
      addToast('Event scheduled!', 'success');
      const id = res.data?.data?.id;
      if (!id) {
        navigate('/sessions');
        return;
      }
      navigate(`/sessions/${id}?invite=1`);
    },
    onError: ev.refused,
    onSettled: ev.settled,
  });
  const submit = ev.onSubmit((values) => create.mutate(eventBody(values, { isAdmin })));
  const typeLabel = pod ? POD_TYPES[pod.podType]?.label : undefined;

  return (
    // noValidate: the browser does not judge the form; the schema says every problem at its field, in REASON's words.
    <form ref={ev.formRef} onSubmit={submit} noValidate className="space-y-6">
      <Card className="animate-fade-in-up">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800 mb-4">
          <Settings className="h-5 w-5 text-rsn-red" /> Basic Info
        </h2>
        <div className="space-y-5">
          {fixedPod ? (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-medium text-gray-500">Pod</p>
              <p className="mt-0.5 text-sm font-semibold text-[#1a1a2e] [overflow-wrap:anywhere]">
                In {fixedPod.name}{typeLabel ? ` · ${typeLabel}` : ''}
              </p>
            </div>
          ) : (
            <div>
              <label htmlFor={podFieldId} className={EVENT_LABEL}>Pod</label>
              <select
                id={podFieldId}
                className={cn(EVENT_FIELD, fieldBorder(errors.podId?.message))}
                aria-invalid={errors.podId ? true : undefined}
                {...register('podId', { onChange: (e) => followPod(podOf(e.target.value), ev.formatChosen.current) })}
              >
                <option value="">Select a pod</option>
                {pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {errors.podId && <p className="text-xs text-red-500 mt-1">{errors.podId.message}</p>}
            </div>
          )}

          <EventTypePicker {...ev.picker(offeredFormats(pod?.podType ?? null), pod ? undefined : 'Choose a pod to see the event types it holds.')} />

          <Input
            label="Title"
            maxLength={TITLE_MAX}
            placeholder="What will you discuss?"
            error={errors.title?.message}
            className={FIELD_SCROLL_MARGINS}
            {...register('title')}
          />

          <div>
            <label htmlFor={descriptionId} className={EVENT_LABEL}>Description <span className="font-normal text-gray-400">(optional)</span></label>
            <textarea
              id={descriptionId}
              rows={2}
              maxLength={DESCRIPTION_MAX}
              placeholder="Describe the event topic..."
              className={cn(EVENT_FIELD, fieldBorder(errors.description?.message), 'resize-none placeholder:text-gray-400')}
              aria-invalid={errors.description ? true : undefined}
              {...register('description')}
            />
            {errors.description && <p className="text-xs text-red-500 mt-1">{errors.description.message}</p>}
          </div>

          <div>
            <Input label="Date and time" type="datetime-local" error={errors.scheduledAt?.message} className={FIELD_SCROLL_MARGINS} {...register('scheduledAt')} />
            <p className="text-xs text-gray-400 mt-1">
              Shown in your local time — {localTimezoneLabel()}. Each person sees the event in their own timezone.
            </p>
          </div>
        </div>
      </Card>

      <Card className="animate-fade-in-up stagger-1">
        <EventFormatFields
          format={ev.format}
          register={register}
          errors={errors}
          durationMinutes={watch('durationMinutes')}
          isAdmin={isAdmin}
          templates={templates}
          templatesLoading={templatesLoading}
          onTouched={ev.touch}
        />
      </Card>

      {/* The submit stays in view, with the summary of anything to fix beside it: just above the phone's bottom bar,
          and 12px above the foot of the window (and its safe area) from 721px, where there is no bottom bar. A sticky
          offset is measured inside <main>'s bottom padding (ReasonShell: 96px plus the safe area on a phone, 40px from
          721px), hence the negative offsets: 72px (the 69px bar and a gap) less 96px; 12px plus the safe area less 40px. */}
      <div ref={ev.barRef} className="sticky bottom-[-24px] z-20 min-[721px]:bottom-[calc(env(safe-area-inset-bottom)_-_28px)]">
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-2xl border border-gray-200 bg-white/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <FormSummary className="basis-full sm:basis-auto sm:flex-1" summary={ev.summary} message={ev.formError} onGoTo={ev.goTo} />
          <Button variant="ghost" type="button" onClick={() => navigate(back)}>Cancel</Button>
          <Button type="submit" isLoading={create.isPending} className="btn-glow">Schedule Event</Button>
        </div>
      </div>
    </form>
  );
}
