// client/src/features/reason/entities/EditServicesSheet.tsx
// [Edit services] for an entity's admins (and platform admins), Shirley pilot S7 (RSN 15): tick what it offers from the
// controlled list; each ticked service may say a little more (280 characters) and link to a secure website. Saving
// sends the whole list. Mounted only while open, so it starts from the services as they are now. Every control is
// 44px tall and 16px on a phone (no zoom), and the sheet scrolls inside itself, so 360px has no sideways scroll.
import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ENTITY_LIMITS, ENTITY_SERVICE_CATEGORIES, type EntityInfo, type EntityService, type EntityServiceCategory } from '@rsn/shared';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '../ui/Sheet';
import { statusOf } from '../human/profile-text';
import { TextAreaField, TextField } from './EntityFields';
import { entityKeys, setEntityServices } from './entity-api';
import {
  characterCount, checkedCategories, descriptionField, onField, serviceLabel, servicesBody, servicesDefaults,
  servicesFieldErrors, servicesSchema, websiteField, type ServicesFormValues,
} from './entity-services-form';
import { formResolver } from './entity-form';
import { entityError } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

interface Props { entity: EntityInfo; services: EntityService[] | undefined; onClose: () => void }

const errorDetails = (err: unknown) =>
  (err as { response?: { data?: { error?: { details?: unknown } } } } | null)?.response?.data?.error?.details;

export default function EditServicesSheet({ entity, services, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const formId = useId();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const { register, handleSubmit, watch, setError: setFieldError, formState: { errors } } = useForm<ServicesFormValues>({
    defaultValues: servicesDefaults(services),
    resolver: formResolver(servicesSchema),
  });
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  useEffect(() => { errorLine.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  const values = watch();

  const save = useMutation({
    networkMode: 'always',
    mutationFn: (v: ServicesFormValues) => setEntityServices(entity.id, servicesBody(v)),
    onSuccess: async () => {
      addToast(`${entity.name}'s services are saved.`, 'success');
      await qc.invalidateQueries({ queryKey: entityKeys.all });
      onClose();
    },
    onError: (err, v) => {
      const { fields, general } = statusOf(err) === 400 ? servicesFieldErrors(errorDetails(err), checkedCategories(v)) : { fields: {}, general: null };
      for (const [field, message] of Object.entries(fields)) setFieldError(field, { type: 'server', message });
      if (Object.keys(fields).length === 0) setError(general ?? entityError(err, 'Could not save the services just now. Try again in a moment.'));
      // Gone (archived meanwhile) or no longer an admin: the page finds out and says so.
      const status = statusOf(err);
      return status === 404 || status === 403 ? qc.invalidateQueries({ queryKey: entityKeys.page(entity.id) }) : undefined;
    },
    onSettled: () => { sending.current = false; },
  });

  const submit = handleSubmit((v) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    save.mutate(v);
  });

  // While the save is on its way the sheet stays open, so what it answers is said where the member is looking.
  const close = () => { if (!save.isPending) onClose(); };
  const message = (field: string) => {
    const e = errors[field];
    return typeof e?.message === 'string' ? e.message : undefined;
  };

  return (
    <Sheet
      open
      onClose={close}
      title={`Services of ${entity.name}`}
      footer={(
        <>
          <button type="button" onClick={close} disabled={save.isPending} className={QUIET_BUTTON}>Cancel</button>
          <button type="submit" form={formId} disabled={save.isPending} className={PRIMARY_BUTTON}>{save.isPending ? 'Saving…' : 'Save services'}</button>
        </>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="mt-3.5 grid gap-2 pb-1" data-testid="entity-services-form">
        <p className="text-[13px] text-[#646a77]">Tick what {entity.name} offers. These show on its page only, never on anyone&apos;s profile.</p>
        {ENTITY_SERVICE_CATEGORIES.map((c: EntityServiceCategory) => {
          const on = values[onField(c)] === true;
          const description = String(values[descriptionField(c)] ?? '');
          return (
            <fieldset key={c} className="min-w-0 rounded-[14px] border border-reason-line px-3">
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[15px] font-bold md:text-[14px]">
                <input type="checkbox" {...register(onField(c))} className="h-5 w-5 shrink-0 text-[16px] accent-reason-red" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{serviceLabel(c)}</span>
              </label>
              {on && (
                <div className="grid gap-3 pb-3">
                  <div className="grid gap-1">
                    <TextAreaField
                      label="Description" optional error={message(descriptionField(c))}
                      registration={register(descriptionField(c))} rows={2} maxLength={ENTITY_LIMITS.serviceDescriptionMax * 2}
                    />
                    <p className="text-right text-[12px] text-[#646a77]" aria-live="polite">
                      {characterCount(description.trim())}/{ENTITY_LIMITS.serviceDescriptionMax}
                    </p>
                  </div>
                  <TextField
                    label="Website" optional error={message(websiteField(c))} registration={register(websiteField(c))}
                    maxLength={ENTITY_LIMITS.websiteMax} inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false}
                    placeholder="https://"
                  />
                </div>
              )}
            </fieldset>
          );
        })}
        {error && <p ref={errorLine} role="alert" className="text-[13px] text-reason-red-hover">{error}</p>}
      </form>
    </Sheet>
  );
}
