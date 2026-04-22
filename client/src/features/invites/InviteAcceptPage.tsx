import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { Users, Calendar, LogIn, UserPlus, Clock, User, AlertCircle } from 'lucide-react';
import api from '@/lib/api';

/** Map accept-invite error codes to user-friendly messages */
function getAcceptErrorMessage(err: any): { message: string } {
  const code = err?.response?.data?.error?.code;
  const message = err?.response?.data?.error?.message;

  switch (code) {
    case 'INVITE_REVOKED':
      return { message: 'This invite has been revoked by the sender' };
    case 'INVITE_EXPIRED':
      return { message: 'This invite has expired and is no longer valid' };
    case 'INVITE_ALREADY_USED':
      return { message: 'This invite has already been used the maximum number of times' };
    case 'EVENT_ENDED':
      return { message: 'This event has already ended' };
    case 'SESSION_ALREADY_REGISTERED':
      return { message: 'You\'re already registered for this event' };
    case 'POD_MEMBER_EXISTS':
      return { message: 'You\'re already a member — navigating to the event' };
    default:
      return { message: message || 'Failed to accept invite' };
  }
}

function formatEventDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export default function InviteAcceptPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const [invite, setInvite] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoAcceptedRef = useRef(false);

  useEffect(() => {
    api.get(`/invites/${code}`).then(r => setInvite(r.data.data)).catch(() => setInvite(null)).finally(() => setLoading(false));
  }, [code]);

  // T0-4 — fallback destination only used if server somehow returns success
  // without a redirectTo (defensive). The happy path uses res.data.data.redirectTo
  // which the server now computes authoritatively (live lobby for session,
  // pod page for pod, dashboard for malformed invites).
  const fallbackDestination = useCallback(() => {
    if (invite?.sessionId) return `/sessions/${invite.sessionId}/live`;
    if (invite?.podId) return `/pods/${invite.podId}`;
    return '/sessions';
  }, [invite]);

  const accept = useCallback(async () => {
    if (autoAcceptedRef.current) return; // guard against double-click / re-entry
    autoAcceptedRef.current = true;
    setAccepting(true);
    setError(null);
    try {
      // T0-4 — server runs ALL registration writes inside the same transaction
      // as the invite UPDATE. If anything fails, the invite stays pending and
      // we get a structured error here. Server response includes redirectTo
      // so we don't have to guess where to send the user.
      const res = await api.post(`/invites/${code}/accept`);
      const data = res.data?.data;
      const destination = data?.redirectTo || fallbackDestination();

      addToast('Invite accepted!', 'success');
      qc.invalidateQueries({ queryKey: ['session-participants'] });
      qc.invalidateQueries({ queryKey: ['session-detail'] });
      // Full page reload ensures fresh data — React Router navigate can hit stale cache
      setTimeout(() => { window.location.href = destination; }, 50);
    } catch (err: any) {
      const errCode = err?.response?.data?.error?.code;
      // T0-4 — INVITE_ALREADY_USED for THIS user is now treated server-side
      // as idempotent re-acceptance (returns success + redirectTo). So if we
      // see INVITE_ALREADY_USED here, it means a DIFFERENT user already
      // consumed it. EVENT_ENDED, INVITE_EXPIRED, INVITE_REVOKED are real
      // errors. The old recovery chain (mark-accepted + register) is gone —
      // the server transaction is the source of truth.
      const { message } = getAcceptErrorMessage(err);
      setError(message);
      addToast(message, 'error');
      autoAcceptedRef.current = false; // allow user to retry
      // Suppress unused-var lint
      void errCode;
    } finally {
      setAccepting(false);
    }
  }, [code, invite, user, navigate, addToast, fallbackDestination, qc]);

  // Pre-emptive check: if session has already ended, show error without attempting accept
  const eventEnded = invite?.sessionStatus === 'completed' || invite?.sessionStatus === 'cancelled';

  // NOTE: auto-accept was removed (April 17, items #6/#12). Users must explicitly
  // click "Accept Invite" so merely viewing an invite link does NOT register them
  // for the session. Keeping `autoAcceptedRef` to guard against double-clicks.
  useEffect(() => {
    if (eventEnded && !error) {
      setError('This event has already ended');
    }
  }, [eventEnded, error]);

  // Show loader while fetching invite only — never auto-accept on landing
  if (loading) return <PageLoader />;

  const InviteIcon = invite?.type === 'session' ? Calendar : Users;
  const inviteLabel = invite?.type === 'pod' ? 'a pod' : invite?.type === 'session' ? 'an event' : 'RSN';

  // Derive display values from enriched invite data
  const targetName = invite?.sessionTitle || invite?.podName;
  const inviterName = invite?.inviterName;
  const description = invite?.sessionDescription || invite?.podDescription;
  const scheduledAt = invite?.sessionScheduledAt;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-white to-gray-50/50 p-4">
      <Card className="max-w-md w-full text-center">
        {invite ? (
          <>
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-rsn-red-light text-rsn-red mx-auto mb-4">
              <InviteIcon className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">You&apos;re invited!</h2>

            {/* Invite context section */}
            <div className="mb-6 space-y-3">
              {inviterName && (
                <div className="flex items-center justify-center gap-2 text-sm text-gray-600">
                  <User className="h-4 w-4 text-gray-400 flex-shrink-0" />
                  <span><span className="font-medium text-[#1a1a2e]">{inviterName}</span> invited you to join {inviteLabel}</span>
                </div>
              )}
              {!inviterName && (
                <p className="text-gray-500 text-sm">
                  You&apos;ve been invited to join {inviteLabel}.
                </p>
              )}

              {targetName && (
                <div className="rounded-xl bg-gray-50 border border-gray-100 p-4 text-left space-y-2">
                  <p className="font-semibold text-[#1a1a2e]">{targetName}</p>
                  {description && (
                    <p className="text-sm text-gray-500 line-clamp-3">{description}</p>
                  )}
                  {scheduledAt && (
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <Clock className="h-4 w-4 text-rsn-red flex-shrink-0" />
                      <span>{formatEventDate(scheduledAt)}</span>
                    </div>
                  )}
                </div>
              )}

              {!inviterName && !targetName && (
                <p className="text-gray-500 text-sm">
                  Sign in or create an account to get started.
                </p>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-100 p-3 mb-4 text-left">
                <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-red-600 text-sm">{error}</p>
              </div>
            )}
            {user ? (
              <Button onClick={accept} isLoading={accepting} className="w-full">
                {error ? 'Try Again' : 'Accept Invite'}
              </Button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-gray-400 mb-2">
                  Sign in or create an account to accept this invite.
                </p>
                <Button onClick={() => navigate(`/login?redirect=/invite/${code}&inviteCode=${code}`)} className="w-full">
                  <LogIn className="h-4 w-4 mr-2" /> Sign In
                </Button>
                <Button variant="secondary" onClick={() => navigate(`/login?redirect=/invite/${code}&inviteCode=${code}`)} className="w-full">
                  <UserPlus className="h-4 w-4 mr-2" /> Create Account
                </Button>
                <p className="text-xs text-gray-400 mt-2">
                  After signing in, you&apos;ll be taken directly to {inviteLabel}.
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-red-50 text-red-400 mx-auto mb-4">
              <AlertCircle className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold text-[#1a1a2e] mb-2">Invalid Invite</h2>
            <p className="text-gray-500 mb-4">This invite link is invalid or has expired.</p>
            <Button variant="secondary" onClick={() => navigate('/')}>Go Home</Button>
          </>
        )}
      </Card>
    </div>
  );
}
