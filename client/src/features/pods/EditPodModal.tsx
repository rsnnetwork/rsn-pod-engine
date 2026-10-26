// client/src/features/pods/EditPodModal.tsx
// Edit Pod (26 Oct 2026), moved off the pod page into its own react-hook-form sheet (it was useState, against the
// house rules). The same fields as Create a Pod. The saved orchestration counts as chosen; an old combination (a
// Reason pod on timed rounds) is shown as its type reads it, with a note, and saved only on Save. A change of type
// says that events already scheduled keep their event type.
import { useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Sheet from '@/features/reason/ui/Sheet';
import FormSummary from '@/components/ui/FormSummary';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import PodFormFields from './PodFormFields';
import { editPodValues, podChanges, podProblemSummary, podProblems, type PodField, type PodFormValues, type PodSource } from './pod-type-form';

interface Props {
  open: boolean;
  onClose: () => void;
  pod: PodSource & { id: string };
}

const COPY = {
  fallback: 'Could not save the pod just now. Try again in a moment.',
  forbidden: "Only the pod's director or a host can change it.",
};

export default function EditPodModal({ open, onClose, pod }: Props) {
  // Mounted only while open, so every opening starts from the pod as it is now.
  if (!open) return null;
  return <EditPodSheet onClose={onClose} pod={pod} />;
}

function EditPodSheet({ onClose, pod }: { onClose: () => void; pod: Props['pod'] }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const formId = useId();
  const [start] = useState(() => editPodValues(pod));
  const form = useForm<PodFormValues>({ defaultValues: start.values });
  const { handleSubmit, setError, setFocus, formState: { errors } } = form;
  const [formError, setFormError] = useState<string | null>(null);
  const sending = useRef(false);

  const save = useMutation({
    networkMode: 'always',
    mutationFn: (values: PodFormValues) => api.put(`/pods/${pod.id}`, podChanges(values)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pod', pod.id] });
      addToast('Pod updated', 'success');
      onClose();
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
    save.mutate(values);
  });

  const close = () => { if (!save.isPending) onClose(); };
  const summary = podProblemSummary(Object.keys(errors));

  return (
    <Sheet
      open
      onClose={close}
      title="Edit Pod"
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <FormSummary className="basis-full sm:basis-auto sm:flex-1" summary={summary} message={formError} onGoTo={(key) => setFocus(key as PodField)} />
          <Button variant="ghost" type="button" onClick={close} disabled={save.isPending}>Cancel</Button>
          <Button type="submit" form={formId} isLoading={save.isPending}>Save Changes</Button>
        </div>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="pb-2 pt-3">
        <PodFormFields
          form={form}
          chosen={start.chosen}
          initialNotices={[]}
          mode="edit"
          legacyNote={start.note}
        />
      </form>
    </Sheet>
  );
}
