// client/src/features/pods/CreatePodModal.tsx
// Create a Pod, and Duplicate Pod (26 Oct 2026): a sheet (a bottom sheet on phones, a dialog from 768px) whose submit
// stays in its sticky footer, with the summary of anything to fix beside it. The type decides the orchestration
// (a Reason pod is Freeform without the member touching it) and the communication, from the shared table.
import { useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import Sheet from '@/features/reason/ui/Sheet';
import FormSummary from '@/components/ui/FormSummary';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { formResolver } from '@/lib/form-resolver';
import PodFormFields from './PodFormFields';
import { newPodValues, podBody, podProblemSummary, podProblems, podFormSchema, type PodField, type PodFormValues, type PodSource } from './pod-type-form';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pre-fill the form (used by "Duplicate Pod"). */
  initialValues?: PodSource;
}

const COPY = { fallback: 'Could not create the pod just now. Try again in a moment.', forbidden: 'You cannot create a pod with this account.' };

export default function CreatePodModal({ open, onClose, initialValues }: Props) {
  // Mounted only while open, so every opening starts from the type's defaults (or the pod being duplicated).
  if (!open) return null;
  return <CreatePodSheet onClose={onClose} initialValues={initialValues} />;
}

function CreatePodSheet({ onClose, initialValues }: { onClose: () => void; initialValues?: PodSource }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const formId = useId();
  // Once per opening: the page passes a fresh initialValues object on every render.
  const [start] = useState(() => newPodValues(initialValues));
  // Checked by the pod schema (name, max members), in the same words as before, through the shared resolver.
  const form = useForm<PodFormValues>({ defaultValues: start.values, resolver: formResolver(podFormSchema) });
  const { handleSubmit, setError, setFocus, formState: { errors } } = form;
  const [formError, setFormError] = useState<string | null>(null);
  // A ref, not isPending: a double tap lands before React draws the button as disabled.
  const sending = useRef(false);
  const duplicating = !!initialValues;

  const create = useMutation({
    networkMode: 'always',
    mutationFn: (values: PodFormValues) => api.post('/pods', podBody(values)),
    onSuccess: (res) => {
      const newPodId = res.data?.data?.id;
      qc.invalidateQueries({ queryKey: ['my-pods'] });
      addToast(duplicating ? 'Pod duplicated!' : 'Pod created!', 'success');
      onClose();
      if (newPodId && !duplicating) navigate(`/pods/${newPodId}`);
    },
    onError: (err) => {
      const { fields, form: message } = podProblems(err, COPY);
      const keys = Object.keys(fields) as PodField[];
      for (const key of keys) setError(key, { type: 'server', message: fields[key] });
      setFormError(message);
      if (keys.length > 0) setFocus(keys[0]);
    },
    onSettled: () => { sending.current = false; },
  });

  const submit = handleSubmit((values) => {
    if (sending.current) return;
    sending.current = true;
    setFormError(null);
    create.mutate(values);
  });

  const close = () => { if (!create.isPending) onClose(); };
  const summary = podProblemSummary(Object.keys(errors));

  return (
    <Sheet
      open
      onClose={close}
      title={duplicating ? 'Duplicate Pod' : 'Create a Pod'}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <FormSummary className="basis-full sm:basis-auto sm:flex-1" summary={summary} message={formError} onGoTo={(key) => setFocus(key as PodField)} />
          <Button variant="ghost" type="button" onClick={close} disabled={create.isPending}>Cancel</Button>
          {/* In the footer, outside the form, and still its submit button: Enter in a field sends the form. */}
          <Button type="submit" form={formId} isLoading={create.isPending} className="btn-glow">
            {duplicating ? 'Duplicate Pod' : 'Create Pod'}
          </Button>
        </div>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="pb-2 pt-3">
        <PodFormFields form={form} chosen={start.chosen} initialNotices={start.notices} mode="create" />
      </form>
    </Sheet>
  );
}
