// ─── Allowed emails: paste addresses or import a CSV, then the list (Part 2 Task 11; spec 04) ───────────────────────
// Pasted text is split with string steps (admission-text.ts); a CSV is read in the browser with FileReader, 256 KB at
// most, and its text is sent for the server to read. The answer says what happened ("2 added, 1 already listed").
// The list is the server's, a page at a time, searchable; a name shows only for an address whose person already
// holds a place (the server's rule). Removing an address asks first.
import { useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FileUp, Loader2 } from 'lucide-react';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { organiserSentence } from '../organiser-errors';
import { FIELD, FieldError, LABEL, PRIMARY_BUTTON, QUIET_BUTTON, fieldBorder } from '../organiser-ui';
import { ADMISSION_COPY, ADMISSION_EMAILS_PER_CALL, CSV_MAX_BYTES, addedSentence, csvHasTooManyRows, splitPastedEmails } from './admission-text';
import { useAddAdmissionEmails } from './useAdmission';
import AdmissionEmailList from './AdmissionEmailList';

const pasteSchema = z.object({ text: z.string().trim().min(1, ADMISSION_COPY.noAddresses).max(CSV_MAX_BYTES, ADMISSION_COPY.csvTooBig) });
type PasteValues = z.infer<typeof pasteSchema>;

/** The file's text, read in the browser. Rejects for a file over the limit or one that cannot be read as text. */
function readCsv(file: File): Promise<string> {
  if (file.size > CSV_MAX_BYTES) return Promise.reject(new Error(ADMISSION_COPY.csvTooBig));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(ADMISSION_COPY.csvUnreadable)));
    reader.onerror = () => reject(new Error(ADMISSION_COPY.csvUnreadable));
    reader.readAsText(file);
  });
}

export default function AdmissionEmailsPanel({ sessionId }: { sessionId: string }) {
  const add = useAddAdmissionEmails(sessionId);
  const fieldId = useId();
  const errorId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<{ tone: 'done' | 'problem'; text: string } | null>(null);
  const form = useForm<PasteValues>({ defaultValues: { text: '' }, resolver: formResolver(pasteSchema) });

  const paste = form.handleSubmit(({ text }) => {
    const { emails, repeats } = splitPastedEmails(text);
    if (emails.length === 0) {
      form.setError('text', { type: 'validate', message: ADMISSION_COPY.noAddresses });
      return;
    }
    if (emails.length > ADMISSION_EMAILS_PER_CALL) {
      form.setError('text', { type: 'validate', message: ADMISSION_COPY.tooManyPasted(emails.length) });
      return;
    }
    setOutcome(null);
    add.mutate({ emails, source: 'paste' }, {
      onSuccess: (result) => { setOutcome({ tone: 'done', text: addedSentence(result, repeats) }); form.reset({ text: '' }); },
      onError: (err) => form.setError('text', { type: 'server', message: organiserSentence(err, ADMISSION_COPY.fallback) }),
    });
  });

  const importFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file || add.isPending) return;
    setOutcome(null);
    let csv: string;
    try {
      csv = await readCsv(file);
    } catch (err) {
      setOutcome({ tone: 'problem', text: err instanceof Error ? err.message : ADMISSION_COPY.csvUnreadable });
      return;
    }
    if (csvHasTooManyRows(csv)) {
      setOutcome({ tone: 'problem', text: ADMISSION_COPY.tooManyRows });
      return;
    }
    add.mutate({ csv, source: 'csv' }, {
      onSuccess: (result) => setOutcome({ tone: 'done', text: addedSentence(result) }),
      onError: (err) => setOutcome({ tone: 'problem', text: organiserSentence(err, ADMISSION_COPY.fallback) }),
    });
  };

  const error = form.formState.errors.text?.message;
  return (
    <section data-testid="admission-emails" className="min-w-0 space-y-3 border-t border-gray-100 pt-4">
      <h3 className="text-base font-semibold text-[#1a1a2e]">{ADMISSION_COPY.emailsTitle}</h3>
      <form onSubmit={paste} noValidate className="space-y-2">
        <label htmlFor={fieldId} className={LABEL}>{ADMISSION_COPY.pasteLabel}</label>
        <textarea
          id={fieldId}
          data-testid="admission-paste"
          rows={3}
          placeholder={ADMISSION_COPY.pastePlaceholder}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(FIELD, fieldBorder(error), 'resize-y')}
          {...form.register('text')}
        />
        {error ? <FieldError id={errorId} message={error} /> : <p className="text-xs text-gray-400">{ADMISSION_COPY.pasteHint}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" data-testid="admission-paste-add" disabled={add.isPending} className={PRIMARY_BUTTON}>
            {add.isPending && add.variables?.source === 'paste' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {ADMISSION_COPY.add}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={add.isPending} className={QUIET_BUTTON}>
            {add.isPending && add.variables?.source === 'csv'
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <FileUp className="h-4 w-4" aria-hidden="true" />}
            {ADMISSION_COPY.importCsv}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="admission-csv-input"
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
        </div>
      </form>
      {outcome && (
        <p
          role="status"
          data-testid="admission-emails-outcome"
          className={cn('rounded-xl px-3 py-2 text-sm [overflow-wrap:anywhere]', outcome.tone === 'done' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900')}
        >
          {outcome.text}
        </p>
      )}
      <AdmissionEmailList sessionId={sessionId} />
    </section>
  );
}
