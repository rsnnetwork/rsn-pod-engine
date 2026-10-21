// client/src/features/reason/entities/EntityFields.tsx
// The form controls the entity sheets share, and the block of fields that describes an entity (create and edit).
// Every control is 16px on a phone (iPhone Safari zooms into anything smaller), 44px tall, and says what is wrong
// under itself, outside its label, so the error is not read as part of the field's name.
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { ENTITY_KINDS, ENTITY_KIND_LABELS, ENTITY_LIMITS } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { sizeText } from './entity-text';

const CONTROL = 'w-full rounded-[11px] border bg-white px-3 text-[16px] font-normal text-reason-ink outline-none transition focus:border-[#cfd2d8] focus:shadow-[0_0_0_4px_rgba(222,50,46,.06)] md:text-[14px]';
const border = (error?: string) => (error ? 'border-reason-red' : 'border-reason-line');

interface FieldProps { label: string; optional?: boolean; error?: string; registration: UseFormRegisterReturn }

function Frame({ id, label, optional, error, errorId, children }: { id: string; label: string; optional?: boolean; error?: string; errorId: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-[12px] font-bold">
        {label}{optional && <span className="font-normal text-[#646a77]"> (optional)</span>}
      </label>
      {children}
      {error && <p id={errorId} className="text-[12px] text-reason-red-hover [overflow-wrap:anywhere]">{error}</p>}
    </div>
  );
}

type Native<T> = Omit<T, 'id' | 'name' | 'onChange' | 'onBlur' | 'ref' | 'className'>;

export function TextField({ label, optional, error, registration, ...input }: FieldProps & Native<InputHTMLAttributes<HTMLInputElement>>) {
  const id = useId();
  const errorId = useId();
  return (
    <Frame id={id} label={label} optional={optional} error={error} errorId={errorId}>
      <input
        {...input} {...registration} id={id}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        className={cn(CONTROL, 'min-h-[44px]', border(error))}
      />
    </Frame>
  );
}

export function TextAreaField({ label, optional, error, registration, ...area }: FieldProps & Native<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  const id = useId();
  const errorId = useId();
  return (
    <Frame id={id} label={label} optional={optional} error={error} errorId={errorId}>
      <textarea
        {...area} {...registration} id={id}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        className={cn(CONTROL, 'min-h-[88px] resize-y py-2.5', border(error))}
      />
    </Frame>
  );
}

export function SelectField({ label, optional, error, registration, children, ...select }: FieldProps & Native<SelectHTMLAttributes<HTMLSelectElement>>) {
  const id = useId();
  const errorId = useId();
  return (
    <Frame id={id} label={label} optional={optional} error={error} errorId={errorId}>
      <select
        {...select} {...registration} id={id}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        className={cn(CONTROL, 'min-h-[44px]', border(error))}
      >
        {children}
      </select>
    </Frame>
  );
}

// ---- the fields that describe an entity ----------------------------------------------------------

export type DetailName = 'name' | 'kind' | 'location' | 'size' | 'about' | 'website';

interface DetailProps {
  register: (name: DetailName) => UseFormRegisterReturn;
  errors: Partial<Record<DetailName, string | undefined>>;
  /** The size choices (sizeChoices): the five, plus the entity's own size when it is not one of them. */
  sizes: string[];
  /** Under the name: what the create form knows about the name (already on REASON, taken). */
  afterName?: ReactNode;
  /** After the type: the create form's own role and title. */
  afterKind?: ReactNode;
}

const L = ENTITY_LIMITS;

export function EntityDetailFields({ register, errors, sizes, afterName, afterKind }: DetailProps) {
  return (
    <>
      <TextField label="Name" error={errors.name} registration={register('name')} maxLength={L.nameMax} autoComplete="organization" />
      {afterName}
      <SelectField label="Type" error={errors.kind} registration={register('kind')}>
        {ENTITY_KINDS.map((k) => <option key={k} value={k}>{ENTITY_KIND_LABELS[k]}</option>)}
      </SelectField>
      {afterKind}
      <TextField label="Location" optional error={errors.location} registration={register('location')} maxLength={L.locationMax} />
      <SelectField label="Size" optional error={errors.size} registration={register('size')}>
        <option value="">Choose a size</option>
        {sizes.map((s) => <option key={s} value={s}>{sizeText(s) ?? s}</option>)}
      </SelectField>
      <TextAreaField label="About" optional error={errors.about} registration={register('about')} maxLength={L.aboutMax} rows={3} />
      <TextField
        label="Website" optional error={errors.website} registration={register('website')} maxLength={L.websiteMax}
        inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false}
      />
    </>
  );
}
