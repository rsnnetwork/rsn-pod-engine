// ─── The invite sheet's "Invite by email" and "Share a link" (P29: split out of InvitePickerSheet.tsx, 1 Nov 2026) ─
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Check, Copy } from 'lucide-react';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { LINK_NOT_MADE, emailSchema, inviteErrorSentence, shareLinkNote, type EmailValues, type InviteTarget } from './invite-picker';
import { useInviteByEmail, useShareLink } from './useInviteCandidates';
import { BUTTON, QUIET } from './invite-sheet-style';

/** One address, checked at the field; the server's refusal (already invited, can't be invited) is said there too. */
export function EmailInvite({ target }: { target: InviteTarget }) {
  const addToast = useToastStore((s) => s.addToast);
  const fieldId = useId();
  const errorId = useId();
  const form = useForm<EmailValues>({ defaultValues: { email: '' }, resolver: formResolver(emailSchema) });
  const invite = useInviteByEmail(target, {
    onSuccess: (email) => {
      addToast(`Invitation sent to ${email}.`, 'success');
      form.reset({ email: '' });
    },
    onError: (err) => form.setError('email', { type: 'server', message: inviteErrorSentence(err, 'That invitation could not be sent. Try again.') }),
  });
  // Asked for, so the field is ready to type in (the sheet itself never focuses a field on opening).
  const { setFocus } = form;
  useEffect(() => { setFocus('email'); }, [setFocus]);
  const submit = form.handleSubmit(({ email }) => { if (!invite.isPending) invite.mutate(email); });
  const error = form.formState.errors.email?.message;
  return (
    <form onSubmit={submit} noValidate className="mt-3 grid gap-1.5">
      <label htmlFor={fieldId} className="text-[12px] font-bold">Their email address</label>
      <div className="flex flex-col gap-2 min-[420px]:flex-row">
        <input
          id={fieldId}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="name@example.com"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          {...form.register('email')}
          className="min-h-[44px] min-w-0 flex-1 rounded-[11px] border border-reason-line bg-white px-3 text-[16px] text-reason-ink placeholder:text-reason-muted md:text-[14px]"
        />
        <button type="submit" disabled={invite.isPending} className={cn(BUTTON, 'bg-reason-red text-white enabled:hover:bg-reason-red-hover disabled:opacity-60')}>
          {invite.isPending ? 'Sending…' : 'Send invite'}
        </button>
      </div>
      {error && <p id={errorId} role="alert" className="text-[13px] text-reason-red">{error}</p>}
    </form>
  );
}

/** A link anyone can use, up to the real cap, for a week: what it allows is said before it is made. */
export function ShareLink({ target, cap }: { target: InviteTarget; cap: number }) {
  const [link, setLink] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const make = useShareLink(target, cap, {
    onSuccess: (code) => { setLink(`${window.location.origin}/invite/${code}`); setError(null); },
    onError: (err) => setError(inviteErrorSentence(err, LINK_NOT_MADE)),
  });
  const copyLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <div className="mt-3 grid gap-2">
      <p className="text-[13px] text-reason-muted">{shareLinkNote(target, cap)}</p>
      {link ? (
        <div className="flex gap-2">
          <input
            readOnly
            value={link}
            aria-label="Invite link"
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-[44px] min-w-0 flex-1 rounded-[11px] border border-reason-line bg-reason-soft px-3 text-[16px] text-reason-ink md:text-[14px]"
          />
          <button type="button" onClick={() => void copyLink(link)} className={cn(QUIET, 'shrink-0 px-3')}>
            {copy === 'copied' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { if (!make.isPending) make.mutate(); }}
          disabled={make.isPending}
          className={cn(QUIET, 'w-full disabled:opacity-60')}
        >
          {make.isPending ? 'Making the link…' : 'Make a link'}
        </button>
      )}
      {copy === 'failed' && <p role="status" className="text-[13px] text-reason-muted">Select the link above and copy it.</p>}
      {error && <p role="alert" className="text-[13px] text-reason-red">{error}</p>}
    </div>
  );
}
