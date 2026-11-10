// ─── The allowed-email list itself: search, a page at a time, Remove (Part 2 Task 11) ───────────────────────────────
import { useId, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { organiserSentence } from '../organiser-errors';
import { EmptyRow, ErrorRow, FIELD, LoadingRows, QUIET_BUTTON } from '../organiser-ui';
import { ADMISSION_COPY, EMAIL_STATUS_LABELS } from './admission-text';
import { useAdmissionEmails, useRevokeAdmissionEmail } from './useAdmission';

const STATUS_LOOK = {
  listed: 'bg-gray-100 text-gray-600',
  registered: 'bg-emerald-50 text-emerald-700',
  revoked: 'bg-red-50 text-red-600',
} as const;

export default function AdmissionEmailList({ sessionId }: { sessionId: string }) {
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const searchId = useId();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim().toLowerCase(), 300);
  const list = useAdmissionEmails(sessionId, q);
  const revoke = useRevokeAdmissionEmail(sessionId);
  const rows = list.data?.pages.flatMap((p) => p.entries) ?? [];

  const remove = async (entryId: string, email: string) => {
    if (!(await ask({ title: ADMISSION_COPY.removeTitle(email), body: ADMISSION_COPY.removeBody, confirmLabel: ADMISSION_COPY.remove, tone: 'danger' }))) return;
    revoke.mutate(entryId, {
      onSuccess: () => addToast(ADMISSION_COPY.removed, 'success'),
      onError: (err) => addToast(organiserSentence(err, ADMISSION_COPY.fallback), 'error'),
    });
  };

  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={searchId} className="sr-only">{ADMISSION_COPY.search}</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={ADMISSION_COPY.search}
          className={cn(FIELD, 'border-gray-200 pl-9')}
        />
      </div>
      {list.isLoading && <LoadingRows label="Loading the allowed emails" />}
      {list.isError && <ErrorRow message={ADMISSION_COPY.emailsError} onRetry={() => list.refetch()} />}
      {!list.isLoading && !list.isError && rows.length === 0 && (
        <EmptyRow testId="admission-emails-empty">{q ? ADMISSION_COPY.emailsNoMatch : ADMISSION_COPY.emailsEmpty}</EmptyRow>
      )}
      {rows.length > 0 && (
        <ul data-testid="admission-email-list" className="divide-y divide-gray-100 rounded-xl border border-gray-200">
          {rows.map((row) => (
            <li key={row.id} data-testid="admission-email-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1 basis-40">
                <p className={cn('text-sm [overflow-wrap:anywhere]', row.status === 'revoked' ? 'text-gray-400 line-through' : 'text-[#1a1a2e]')}>{row.email}</p>
                {row.displayName && <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">{row.displayName}</p>}
              </div>
              <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_LOOK[row.status])}>{EMAIL_STATUS_LABELS[row.status]}</span>
              {row.status !== 'revoked' && (
                <button
                  type="button"
                  onClick={() => void remove(row.id, row.email)}
                  disabled={revoke.isPending}
                  aria-label={`${ADMISSION_COPY.remove} ${row.email}`}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <button type="button" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage} className={QUIET_BUTTON}>
          {ADMISSION_COPY.showMore}
        </button>
      )}
      {confirmDialog}
    </div>
  );
}
