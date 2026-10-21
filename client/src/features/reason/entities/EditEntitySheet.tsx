// client/src/features/reason/entities/EditEntitySheet.tsx
// [Edit] for an entity's admins (and platform admins): its name, type, place, size, description and website. Only
// what was changed is sent. Mounted only while open, so it always starts from the entity as it is now.
import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EntityInfo } from '@rsn/shared';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '../ui/Sheet';
import { statusOf } from '../human/profile-text';
import { EntityDetailFields } from './EntityFields';
import { entityKeys, updateEntity } from './entity-api';
import { editChanges, editDefaults, editSchema, formResolver, type EntityChanges, type EntityFormValues } from './entity-form';
import { entityError, fieldErrors, nameTakenId, sizeChoices } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

interface Props { entity: EntityInfo; onClose: () => void }

export default function EditEntitySheet({ entity, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const formId = useId();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const { register, handleSubmit, setError: setFieldError, formState: { errors, dirtyFields } } = useForm<EntityFormValues>({
    defaultValues: editDefaults(entity),
    resolver: formResolver(editSchema),
  });
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);

  const save = useMutation({
    networkMode: 'always',
    mutationFn: (changes: EntityChanges) => updateEntity(entity.id, changes),
    // The sheet closes once the fresh page is in, so it closes onto the entity as saved, not as it was for a moment.
    onSuccess: async (_r, changes) => {
      addToast(`${changes.name ?? entity.name} is saved.`, 'success');
      await qc.invalidateQueries({ queryKey: entityKeys.all });
      onClose();
    },
    onError: (err, changes) => {
      if (nameTakenId(err)) {
        setFieldError('name', { type: 'server', message: `There is already an entity called ${changes.name ?? entity.name}.` });
        return;
      }
      const fields = Object.entries(fieldErrors(err)).filter(([f]) => f !== 'role' && f !== 'title');
      for (const [field, message] of fields) setFieldError(field as keyof EntityFormValues, { type: 'server', message });
      if (fields.length === 0) setError(entityError(err, 'Could not save it just now. Try again in a moment.'));
      // Gone (archived meanwhile): the page finds out and says so, instead of offering an edit that cannot land.
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: entityKeys.page(entity.id) }) : undefined;
    },
    onSettled: () => { sending.current = false; },
  });

  const submit = handleSubmit((values) => {
    const changes = editChanges(values, dirtyFields);
    // Nothing changed: there is nothing to send (the server would answer "Nothing to change.").
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    if (sending.current) return;
    sending.current = true;
    setError(null);
    save.mutate(changes);
  });

  // While the save is on its way the sheet stays open (Cancel, X, Escape and the backdrop wait), so what it answers,
  // a failure included, is said where the member is looking.
  const close = () => { if (!save.isPending) onClose(); };

  return (
    <Sheet
      open
      onClose={close}
      title={`Edit ${entity.name}`}
      footer={(
        <>
          <button type="button" onClick={close} disabled={save.isPending} className={QUIET_BUTTON}>Cancel</button>
          <button type="submit" form={formId} disabled={save.isPending} className={PRIMARY_BUTTON}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
        </>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="mt-3.5 grid gap-3.5 pb-1">
        <EntityDetailFields
          register={(name) => register(name)}
          errors={{
            name: errors.name?.message, kind: errors.kind?.message, location: errors.location?.message,
            size: errors.size?.message, about: errors.about?.message, website: errors.website?.message,
          }}
          sizes={sizeChoices(entity.size)}
        />
        {error && <p ref={errorLine} role="alert" className="text-[13px] text-reason-red-hover">{error}</p>}
      </form>
    </Sheet>
  );
}
