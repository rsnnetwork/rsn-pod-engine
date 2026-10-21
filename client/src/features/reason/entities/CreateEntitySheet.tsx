// client/src/features/reason/entities/CreateEntitySheet.tsx
// "Create your company" (19 Oct feedback: "Users should be able to create an Entity (their company) themselves").
// The v4 prototype has no create flow, so this is its sheet style: a bottom sheet on phones, a dialog from 768px.
// It is mounted only while open, so every opening starts from the defaults (a company, you as its founder).
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ENTITY_LIMITS, ENTITY_ROLES, ENTITY_ROLE_LABELS } from '@rsn/shared';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '../ui/Sheet';
import { EntityDetailFields, SelectField, TextField } from './EntityFields';
import AlreadyOnReason from './AlreadyOnReason';
import NameTaken from './NameTaken';
import { createEntity, entityKeys } from './entity-api';
import { createBody, createDefaults, createSchema, formResolver, type CreateFormValues, type NewEntityBody } from './entity-form';
import { SIZE_OPTIONS, createdToast, entityError, fieldErrors, nameTakenId, tidyName } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

interface Props {
  /** The name to start with: what the member searched for, or nothing. */
  startName: string;
  onClose: () => void;
}

export default function CreateEntitySheet({ startName, onClose }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const formId = useId();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const { register, handleSubmit, setError: setFieldError, watch, formState: { errors } } = useForm<CreateFormValues>({
    defaultValues: createDefaults(startName),
    resolver: formResolver(createSchema),
  });
  // The 409: the name as it was sent, and the entity that already has it.
  const [taken, setTaken] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A ref, not isPending: a double tap lands before React draws the button as disabled.
  const sending = useRef(false);

  const typedName = watch('name');
  // The 409 was about the name that was sent. Once the member changes it, it no longer applies.
  const takenNow = taken && tidyName(typedName).toLowerCase() === taken.name.toLowerCase() ? taken : null;
  // The last thing in a body that scrolls: with the phone keyboard up it would land below the fold.
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);

  // networkMode 'always': offline, the request fails at once and says so, instead of sitting on "Creating…" and going
  // out by itself when the connection returns.
  const create = useMutation({
    networkMode: 'always',
    mutationFn: (body: NewEntityBody) => createEntity(body),
    onSuccess: (result, body) => {
      addToast(createdToast(body.name, result.companyUpdated), 'success');
      onClose();
      navigate(`/entities/${result.id}`);
      return qc.invalidateQueries({ queryKey: entityKeys.all });
    },
    onError: (err, body) => {
      const existingId = nameTakenId(err);
      if (existingId) {
        setTaken({ id: existingId, name: body.name });
        return;
      }
      const fields = Object.entries(fieldErrors(err));
      for (const [field, message] of fields) setFieldError(field as keyof CreateFormValues, { type: 'server', message });
      if (fields.length === 0) setError(entityError(err, 'Could not create it just now. Try again in a moment.'));
    },
    onSettled: () => { sending.current = false; },
  });

  const submit = handleSubmit((values) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    setTaken(null);
    create.mutate(createBody(values));
  });

  return (
    <Sheet
      open
      onClose={onClose}
      title="Create your company"
      footer={(
        <>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>Cancel</button>
          {/* In the footer, outside the form, and still its submit button: Enter in a field sends the form. */}
          <button type="submit" form={formId} disabled={create.isPending} className={PRIMARY_BUTTON}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      )}
    >
      <p className="mt-1 text-[13px] text-[#646a77]">Your company, or any organisation you are part of. People can find it and link themselves to it.</p>
      <form id={formId} onSubmit={submit} noValidate className="mt-3.5 grid gap-3.5 pb-1">
        <EntityDetailFields
          register={(name) => register(name)}
          errors={{
            name: errors.name?.message, kind: errors.kind?.message, location: errors.location?.message,
            size: errors.size?.message, about: errors.about?.message, website: errors.website?.message,
          }}
          sizes={[...SIZE_OPTIONS]}
          afterName={takenNow
            ? <NameTaken taken={takenNow} role={watch('role')} title={watch('title')} onLeave={onClose} />
            : <AlreadyOnReason typedName={typedName} onLeave={onClose} />}
          afterKind={(
            <>
              <SelectField label="Your role" error={errors.role?.message} registration={register('role')}>
                {ENTITY_ROLES.map((r) => <option key={r} value={r}>{ENTITY_ROLE_LABELS[r]}</option>)}
              </SelectField>
              <TextField label="Your title" optional error={errors.title?.message} registration={register('title')} maxLength={ENTITY_LIMITS.titleMax} autoComplete="organization-title" />
            </>
          )}
        />
        {error && <p ref={errorLine} role="alert" className="text-[13px] text-reason-red-hover">{error}</p>}
      </form>
    </Sheet>
  );
}
