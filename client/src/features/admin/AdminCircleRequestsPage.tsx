// ─── Circle requests: a platform admin's review queue (Ben field test, 13 Nov 2026) ───────────────────────────────
// "Request, review, approve, create." Each waiting ask shows who asked, the circle's name, who it is for and why, and who
// can join. Approve makes the circle with the asker as its owner (the admin may give it another name first); Decline
// tells the member, with a reason when one is given. The list follows admin:circle-requests, so an ask made or answered
// anywhere appears without a refresh. Oldest first.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleDashed } from 'lucide-react';
import type { CircleCreationRequestForReview } from '@rsn/shared';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import EmptyState from '@/components/ui/EmptyState';
import Input from '@/components/ui/Input';
import Sheet from '@/features/reason/ui/Sheet';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { isAdmin } from '@/lib/utils';
import { POLICY_LABEL } from '@/features/circles/circle-logic';
import { circleErrorSentence } from '@/features/circles/useCircleActions';
import { useAnswerCircleRequest, useCircleRequestQueue } from '@/features/circles/useCircleRequests';

type Answering = { request: CircleCreationRequestForReview; approve: boolean } | null;

export default function AdminCircleRequestsPage() {
  const { user } = useAuthStore();
  const admin = isAdmin(user?.role);
  const { data, isLoading, isError, refetch } = useCircleRequestQueue(admin);
  const [answering, setAnswering] = useState<Answering>(null);

  if (!admin) return <EmptyState title="Admins only" description="Only REASON admins review circle requests." icon={<CircleDashed className="h-12 w-12" />} />;
  if (isLoading) return <PageLoader />;
  if (isError) {
    return (
      <Card className="!p-4" data-testid="circle-requests-error">
        <p className="text-sm text-gray-600">The circle requests could not be loaded.</p>
        <Button variant="ghost" onClick={() => void refetch()} className="mt-2 min-h-[44px]">Try again</Button>
      </Card>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Circle requests</h1>
        <p className="text-gray-500 text-sm mt-1">Members ask for a circle for their community. Only approved circles go live.</p>
      </div>
      {!data || data.length === 0 ? (
        <EmptyState title="No circle requests waiting" description="New requests appear here as members send them." icon={<CircleDashed className="h-12 w-12" />} />
      ) : (
        <div className="grid gap-3" data-testid="circle-requests-queue">
          {data.map((r) => (
            <Card key={r.id} className="!p-4" data-testid={`circle-request-${r.id}`}>
              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-lg font-semibold text-gray-900 [overflow-wrap:anywhere]">{r.name}</p>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[12px] font-medium text-gray-600">{POLICY_LABEL[r.joinPolicy]}</span>
                </div>
                <p className="text-[13px] text-gray-500">
                  Asked by <span className="font-medium text-gray-700">{r.requester.displayName ?? 'A member'}</span>
                  {r.requester.jobTitle || r.requester.company ? ` · ${[r.requester.jobTitle, r.requester.company].filter(Boolean).join(', ')}` : ''}
                  {' · '}{new Date(r.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                </p>
                <p className="text-sm text-gray-800 whitespace-pre-wrap [overflow-wrap:anywhere]"><span className="font-medium">Who it is for and why: </span>{r.purpose}</p>
                {r.description && <p className="text-sm text-gray-600 whitespace-pre-wrap [overflow-wrap:anywhere]">{r.description}</p>}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button onClick={() => setAnswering({ request: r, approve: true })} className="min-h-[44px]" data-testid="circle-request-approve">Approve</Button>
                  <Button variant="outline" onClick={() => setAnswering({ request: r, approve: false })} className="min-h-[44px]" data-testid="circle-request-decline">Decline</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {answering && <AnswerSheet answering={answering} onClose={() => setAnswering(null)} />}
    </div>
  );
}

/** Approve (with the name it will have, editable) or decline (with an optional reason the member reads). */
function AnswerSheet({ answering, onClose }: { answering: NonNullable<Answering>; onClose: () => void }) {
  const { request, approve } = answering;
  const [name, setName] = useState(request.name);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const answer = useAnswerCircleRequest();
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const nameTooShort = approve && name.trim().length < 2;

  const submit = () => {
    if (answer.isPending || nameTooShort) return;
    setError(null);
    const body = approve
      ? { requestId: request.id, approve: true as const, name: name.trim() !== request.name ? name.trim() : undefined }
      : { requestId: request.id, approve: false as const, reason: reason.trim() || undefined };
    answer.mutate(body, {
      onSuccess: (made) => {
        onClose();
        if (approve && made) {
          addToast(`${name.trim()} is live. ${request.requester.displayName ?? 'The member'} is its owner.`, 'success');
          navigate(`/circles/${made.circleId}`);
        } else {
          addToast(`${request.name} was declined. ${request.requester.displayName ?? 'The member'} has been told.`, 'success');
        }
      },
      onError: (err) => setError(circleErrorSentence(err, 'That could not be saved. Try again.')),
    });
  };

  return (
    <Sheet
      open
      onClose={() => { if (!answer.isPending) onClose(); }}
      title={approve ? 'Approve this circle?' : 'Decline this circle?'}
      footer={(
        <>
          <Button variant="ghost" type="button" onClick={onClose} disabled={answer.isPending} className="min-h-[44px]">Cancel</Button>
          <Button type="button" onClick={submit} isLoading={answer.isPending} disabled={nameTooShort} data-testid="circle-request-confirm" className="min-h-[44px]">
            {approve ? 'Approve and create' : 'Decline'}
          </Button>
        </>
      )}
    >
      <div className="mt-2 space-y-3">
        {approve ? (
          <>
            <p className="text-[14px] text-reason-muted">
              The circle goes live now, with {request.requester.displayName ?? 'the member'} as its owner and "{POLICY_LABEL[request.joinPolicy]}" as who can join.
            </p>
            <Input label="Circle name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-testid="circle-request-approve-name"
              error={nameTooShort ? 'Give it a name of at least 2 characters.' : undefined} />
          </>
        ) : (
          <div>
            <label htmlFor="circle-request-reason" className="block text-sm font-medium text-gray-600 mb-1.5">Reason <span className="font-normal text-gray-400">(optional, the member sees it)</span></label>
            <textarea id="circle-request-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
              data-testid="circle-request-reason"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-base sm:text-[15px] text-gray-900 focus:border-rsn-red focus:outline-none" />
          </div>
        )}
        {error && <p role="alert" className="text-[13px] text-reason-red">{error}</p>}
      </div>
    </Sheet>
  );
}
