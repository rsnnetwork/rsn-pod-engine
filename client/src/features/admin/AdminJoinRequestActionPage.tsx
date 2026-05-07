// ─── Admin Join Request Action Page ───────────────────────────────────────
//
// Lands when an admin clicks Approve/Reject in their email. The token in
// the URL is the auth — we don't require a logged-in session. The page:
//   1. Peeks the token (read-only) to validate + fetch the request snapshot
//   2. Shows one of four states: loading / ready / already_processed / expired
//   3. On Confirm click → POSTs to /confirm; finalises the action and shows
//      a success card.
//
// The two-step (peek GET + confirm POST) is intentional: Outlook Safe
// Links and Gmail crawlers prefetch GET URLs and would silently consume
// a one-click GET. Peek is read-only (safe to prefetch); Confirm is POST.
//
// Mobile-responsive at 360 / 414 / 768 / 1024 widths per RajaSkill rule.

import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, XCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/Button';

type ActionKind = 'approve' | 'reject';

type PeekState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      action: ActionKind;
      adminUserId: string;
      request: {
        id: string;
        fullName: string;
        email: string;
        linkedinUrl: string | null;
        reason: string | null;
        status: string;
        createdAt: string;
      };
    }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | {
      kind: 'already_processed';
      action: ActionKind;
      requestStatus: string;
      reviewedByName: string | null;
      reviewedAt: string | null;
    }
  | {
      kind: 'success';
      action: ActionKind;
      applicantName: string;
    }
  | { kind: 'error'; message: string };

const dashboardUrl = '/admin/join-requests';

export default function AdminJoinRequestActionPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<PeekState>({ kind: 'loading' });
  const [submitting, setSubmitting] = useState(false);

  const peek = useCallback(async () => {
    if (!token) {
      setState({ kind: 'invalid' });
      return;
    }
    try {
      const res = await api.get(`/admin/join-request-action/${encodeURIComponent(token)}`);
      const data = res.data?.data;
      if (!data || !data.kind) {
        setState({ kind: 'error', message: 'Unexpected response from the server.' });
        return;
      }
      setState(data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429) {
        setState({ kind: 'error', message: 'Too many requests. Try again in a few minutes.' });
      } else {
        setState({ kind: 'error', message: 'Could not reach the server.' });
      }
    }
  }, [token]);

  useEffect(() => { peek(); }, [peek]);

  const onConfirm = async () => {
    if (!token || state.kind !== 'ready') return;
    setSubmitting(true);
    try {
      const res = await api.post(`/admin/join-request-action/${encodeURIComponent(token)}/confirm`);
      const data = res.data?.data;
      if (data?.kind === 'success') {
        setState({ kind: 'success', action: data.action, applicantName: data.request.fullName });
      } else if (data?.kind === 'already_processed') {
        setState({
          kind: 'already_processed',
          action: state.action,
          requestStatus: data.requestStatus,
          reviewedByName: data.reviewedByName,
          reviewedAt: null,
        });
      } else if (data?.kind === 'expired') {
        setState({ kind: 'expired' });
      } else {
        setState({ kind: 'error', message: 'Could not finalise this action. Open the dashboard to retry.' });
      }
    } catch {
      setState({ kind: 'error', message: 'Could not finalise this action. Open the dashboard to retry.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-gray-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-gray-200 p-6 sm:p-8">
        {state.kind === 'loading' && <LoadingCard />}
        {state.kind === 'ready' && (
          <ReadyCard
            action={state.action}
            request={state.request}
            submitting={submitting}
            onConfirm={onConfirm}
            onCancel={() => navigate(dashboardUrl)}
          />
        )}
        {state.kind === 'success' && (
          <SuccessCard action={state.action} applicantName={state.applicantName} onClose={() => navigate(dashboardUrl)} />
        )}
        {state.kind === 'already_processed' && (
          <AlreadyProcessedCard
            requestStatus={state.requestStatus}
            reviewedByName={state.reviewedByName}
            onClose={() => navigate(dashboardUrl)}
          />
        )}
        {state.kind === 'expired' && <ExpiredCard onOpen={() => navigate(dashboardUrl)} />}
        {state.kind === 'invalid' && <InvalidCard onOpen={() => navigate(dashboardUrl)} />}
        {state.kind === 'error' && <ErrorCard message={state.message} onOpen={() => navigate(dashboardUrl)} />}
      </div>
    </div>
  );
}

// ─── Cards ────────────────────────────────────────────────────────────────

function LoadingCard() {
  return (
    <div className="text-center py-8">
      <Loader2 className="h-8 w-8 text-rsn-red animate-spin mx-auto mb-4" />
      <p className="text-sm text-gray-500">Loading the join request…</p>
    </div>
  );
}

function ReadyCard({
  action,
  request,
  submitting,
  onConfirm,
  onCancel,
}: {
  action: ActionKind;
  request: { fullName: string; email: string; linkedinUrl: string | null; reason: string | null };
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isApprove = action === 'approve';
  return (
    <>
      <h1 className="text-lg font-semibold text-gray-900 mb-1">
        {isApprove ? 'Approve this request?' : 'Decline this request?'}
      </h1>
      <p className="text-sm text-gray-500 mb-5">
        {isApprove
          ? `${request.fullName} will receive a welcome email immediately.`
          : `${request.fullName} will receive a decline email.`}
      </p>

      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-5">
        <Field label="Name" value={request.fullName} />
        <Field label="Email" value={request.email} />
        {request.linkedinUrl && (
          <Field
            label="LinkedIn"
            value={
              <a href={request.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-rsn-red hover:underline break-all">
                {request.linkedinUrl}
              </a>
            }
          />
        )}
        {request.reason && <Field label="Why RSN" value={request.reason} multiline />}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
        <Button
          onClick={onConfirm}
          disabled={submitting}
          className={`flex-1 ${isApprove ? '' : 'bg-gray-100 hover:bg-gray-200 text-gray-900'}`}
          variant={isApprove ? 'primary' : ('secondary' as any)}
        >
          {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin inline" /> : null}
          {isApprove ? 'Confirm approval' : 'Confirm decline'}
        </Button>
        <Button onClick={onCancel} variant="ghost" disabled={submitting} className="sm:flex-1">
          Cancel
        </Button>
      </div>

      <p className="text-[11px] text-gray-400 mt-4 text-center">
        Nothing was changed when you opened this page. Your decision finalises only when you click confirm.
      </p>
    </>
  );
}

function SuccessCard({ action, applicantName, onClose }: { action: ActionKind; applicantName: string; onClose: () => void }) {
  return (
    <div className="text-center py-2">
      {action === 'approve' ? (
        <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto mb-4" />
      ) : (
        <XCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
      )}
      <h1 className="text-lg font-semibold text-gray-900 mb-2">
        {action === 'approve' ? `Approved ${applicantName}` : `Declined ${applicantName}`}
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        {action === 'approve'
          ? "They've been emailed a welcome link and can sign in right away."
          : "They've been emailed a respectful decline."}
      </p>
      <Button onClick={onClose} variant="secondary">
        Open dashboard
      </Button>
    </div>
  );
}

function AlreadyProcessedCard({
  requestStatus,
  reviewedByName,
  onClose,
}: {
  requestStatus: string;
  reviewedByName: string | null;
  onClose: () => void;
}) {
  const verb = requestStatus === 'approved' ? 'approved' : requestStatus === 'declined' ? 'declined' : 'reviewed';
  return (
    <div className="text-center py-2">
      <AlertCircle className="h-10 w-10 text-amber-500 mx-auto mb-4" />
      <h1 className="text-lg font-semibold text-gray-900 mb-2">Already {verb}</h1>
      <p className="text-sm text-gray-500 mb-6">
        {reviewedByName
          ? `This request was ${verb} by ${reviewedByName}.`
          : `This request has already been ${verb}.`}
      </p>
      <Button onClick={onClose} variant="secondary">
        Open dashboard
      </Button>
    </div>
  );
}

function ExpiredCard({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="text-center py-2">
      <AlertCircle className="h-10 w-10 text-amber-500 mx-auto mb-4" />
      <h1 className="text-lg font-semibold text-gray-900 mb-2">This link has expired</h1>
      <p className="text-sm text-gray-500 mb-6">
        Approval links are valid for 24 hours. Open the dashboard to review the request.
      </p>
      <Button onClick={onOpen}>
        <ExternalLink className="h-4 w-4 mr-2" /> Open dashboard
      </Button>
    </div>
  );
}

function InvalidCard({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="text-center py-2">
      <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
      <h1 className="text-lg font-semibold text-gray-900 mb-2">Invalid link</h1>
      <p className="text-sm text-gray-500 mb-6">
        This link doesn't match a known action. Open the dashboard to find the request.
      </p>
      <Button onClick={onOpen}>
        <ExternalLink className="h-4 w-4 mr-2" /> Open dashboard
      </Button>
    </div>
  );
}

function ErrorCard({ message, onOpen }: { message: string; onOpen: () => void }) {
  return (
    <div className="text-center py-2">
      <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
      <h1 className="text-lg font-semibold text-gray-900 mb-2">Something went wrong</h1>
      <p className="text-sm text-gray-500 mb-6">{message}</p>
      <Button onClick={onOpen} variant="secondary">
        Open dashboard
      </Button>
    </div>
  );
}

function Field({
  label,
  value,
  multiline,
}: {
  label: string;
  value: React.ReactNode;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-3 py-1.5">
      <span className="text-[11px] uppercase tracking-wide text-gray-400 sm:w-20 shrink-0 mt-0.5">{label}</span>
      <span className={`text-sm text-gray-800 ${multiline ? 'whitespace-pre-wrap break-words' : 'break-words'}`}>
        {value}
      </span>
    </div>
  );
}
