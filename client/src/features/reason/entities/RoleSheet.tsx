// client/src/features/reason/entities/RoleSheet.tsx
// "Change": your role at an entity, and your title there. Mounted only while open, so it always starts from your link
// as it is now.
import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ENTITY_LIMITS, ENTITY_ROLES, ENTITY_ROLE_LABELS, type EntityRole } from '@rsn/shared';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '../ui/Sheet';
import { statusOf } from '../human/profile-text';
import { SelectField, TextField } from './EntityFields';
import { entityKeys, setMyEntityRole } from './entity-api';
import { formResolver, roleBody, roleDefaults, roleSchema, type RoleFormValues } from './entity-form';
import { entityError, fieldErrors } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

/** `title` is null when you have none, or when the page does not list you (it holds at most 200 people). */
interface Props { entityId: string; entityName: string; role: EntityRole; title: string | null; onClose: () => void }

export default function RoleSheet({ entityId, entityName, role, title, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const formId = useId();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const { register, handleSubmit, setError: setFieldError, formState: { errors, dirtyFields } } = useForm<RoleFormValues>({
    defaultValues: roleDefaults(role, title),
    resolver: formResolver(roleSchema),
  });
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);

  const save = useMutation({
    networkMode: 'always',
    mutationFn: (body: ReturnType<typeof roleBody>) => setMyEntityRole(entityId, body.role, body.title),
    // The sheet closes once the fresh page is in, so it closes onto the new role, not the old one for a moment.
    onSuccess: async () => {
      addToast(`Your role at ${entityName} is saved.`, 'success');
      await qc.invalidateQueries({ queryKey: entityKeys.all });
      onClose();
    },
    onError: (err) => {
      const fields = Object.entries(fieldErrors(err)).filter(([f]) => f === 'role' || f === 'title');
      for (const [field, message] of fields) setFieldError(field as keyof RoleFormValues, { type: 'server', message });
      if (fields.length === 0) setError(entityError(err, 'Could not save your role just now. Try again in a moment.'));
      // Gone (archived meanwhile): the page finds out and says so.
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: entityKeys.page(entityId) }) : undefined;
    },
    onSettled: () => { sending.current = false; },
  });

  const submit = handleSubmit((values) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    save.mutate(roleBody(values, !!dirtyFields.title));
  });

  return (
    <Sheet
      open
      onClose={onClose}
      title="Your role"
      footer={(
        <>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>Cancel</button>
          <button type="submit" form={formId} disabled={save.isPending} className={PRIMARY_BUTTON}>{save.isPending ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <p className="mt-1 text-[13px] text-[#646a77] [overflow-wrap:anywhere]">How you are linked to {entityName}. People see it next to your name on its page.</p>
      <form id={formId} onSubmit={submit} noValidate className="mt-3.5 grid gap-3.5 pb-1">
        <SelectField label="Your role" error={errors.role?.message} registration={register('role')}>
          {ENTITY_ROLES.map((r) => <option key={r} value={r}>{ENTITY_ROLE_LABELS[r]}</option>)}
        </SelectField>
        <TextField label="Your title" optional error={errors.title?.message} registration={register('title')} maxLength={ENTITY_LIMITS.titleMax} autoComplete="organization-title" />
        {error && <p ref={errorLine} role="alert" className="text-[13px] text-reason-red-hover">{error}</p>}
      </form>
    </Sheet>
  );
}
